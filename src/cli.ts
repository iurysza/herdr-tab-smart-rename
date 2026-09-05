#!/usr/bin/env bun
import { chmod, closeSync, openSync } from "node:fs";
import { chmod as chmodAsync, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type RenameResult } from "./domain.ts";
import { beginTabProgress, run, snapshot } from "./herdr.ts";
import { loadModelSelection } from "./model-selection.ts";
import {
  selectionLabel,
  type ModelSelection,
  type ModelSource,
} from "./model-source.ts";
import { loadModelSource } from "./model-sources/index.ts";
import { loadNamingPrompt, loadProviderConfig } from "./provider.ts";
import { createService } from "./service.ts";
import {
  acquireLock,
  ensurePrivateDir,
  statePaths,
  workerInfo,
  workerIsReady,
  workerOwnership,
} from "./storage.ts";
import { sanitizeText } from "./text.ts";

const root =
  process.env.HERDR_PLUGIN_ROOT || path.resolve(import.meta.dir, "..");
const workerScript = path.join(root, "src", "worker.ts");

function requireStateDir(): string {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!stateDir) {
    throw new Error(
      "HERDR_PLUGIN_STATE_DIR is required (Herdr sets it for plugin actions)",
    );
  }
  return stateDir;
}

async function notify(
  title: string,
  body = "",
  sound: "none" | "done" | "request" = "none",
): Promise<void> {
  const args = ["notification", "show", title];
  const safeBody = sanitizeText(body).slice(0, 120);
  if (safeBody) args.push("--body", safeBody);
  args.push("--position", "bottom-right", "--sound", sound);
  await run(process.env.HERDR_BIN_PATH || "herdr", args, {
    env: process.env,
    timeout: 3_000,
  }).catch(() => {});
}

export function renamedTabCount(results: readonly RenameResult[]): number {
  return results.reduce(
    (count, result) =>
      count + result.changes.filter((change) => change.kind === "tab").length,
    0,
  );
}

export function currentResultNotice(result: RenameResult | null): {
  title: string;
  body: string;
  sound: "done" | "request";
} {
  const failure = result?.outcomes?.find((item) => item.status === "failed");
  if (failure) {
    return { title: "Rename failed", body: failure.reason, sound: "request" };
  }
  const tabChange = result?.changes.find((item) => item.kind === "tab");
  const paneChanges =
    result?.changes.filter((item) => item.kind === "pane") ?? [];
  if (tabChange) {
    return {
      title: "Tab renamed",
      body: `${tabChange.from} -> ${tabChange.to}`,
      sound: "done",
    };
  }
  if (paneChanges.length === 1) {
    const change = paneChanges[0]!;
    return {
      title: "Pane renamed",
      body: `${change.from} -> ${change.to}`,
      sound: "done",
    };
  }
  if (paneChanges.length > 1) {
    return {
      title: "Panes renamed",
      body: `${paneChanges.length} panes`,
      sound: "done",
    };
  }
  if (!result) {
    return {
      title: "Tab not renamed",
      body: "No eligible tab",
      sound: "request",
    };
  }
  return {
    title: "Tab not renamed",
    body: result.candidate.tab
      ? `Already named ${result.candidate.tab}`
      : result.reason === "no meaningful task"
        ? "No meaningful task found"
        : result.reason,
    sound: "request",
  };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

export function otherSocketRecovery(ownerSocket: string): string {
  return [
    `HERDR_SOCKET_PATH=${shellQuote(ownerSocket)} herdr plugin action invoke stop --plugin tab-smart-rename`,
    "herdr plugin action invoke start --plugin tab-smart-rename",
  ].join("\n");
}

// Receipt (2026-08-19): isolated starts took 493ms normally and 306ms with a held start lock; 5000ms is just over ten times the slower observed start.
export const WORKER_READY_TIMEOUT_MS = 5_000;
export const WORKER_READY_POLL_INTERVAL_MS = 50;

export interface WorkerReadinessDependencies {
  readonly lookup: () => Promise<Awaited<ReturnType<typeof workerInfo>>>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export async function waitForWorkerReadiness(
  targetSocket: string,
  {
    lookup,
    sleep = (milliseconds) => Bun.sleep(milliseconds),
    now = () => Date.now(),
    timeoutMs = WORKER_READY_TIMEOUT_MS,
    pollIntervalMs = WORKER_READY_POLL_INTERVAL_MS,
  }: WorkerReadinessDependencies,
): Promise<void> {
  const startedAt = now();
  while (true) {
    const info = await lookup();
    if (!info) throw new Error("Smart Rename worker exited before readiness.");
    if (workerIsReady(info, targetSocket)) return;
    const elapsed = now() - startedAt;
    if (elapsed >= timeoutMs) {
      throw new Error(
        `Smart Rename worker did not become ready for ${targetSocket} after ${elapsed}ms (configured readiness timeout ${timeoutMs}ms).`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

async function start(): Promise<void> {
  const stateDir = requireStateDir();
  await ensurePrivateDir(stateDir);
  const paths = statePaths(stateDir);
  const targetSocket = process.env.HERDR_SOCKET_PATH;
  if (!targetSocket) {
    throw new Error("HERDR_SOCKET_PATH is required to prove Smart Rename worker readiness.");
  }
  const release = await acquireLock(paths.startLock, {
    timeoutMs: 2_000,
    staleMs: 30_000,
  });
  try {
    const existing = await workerInfo(paths.pid, workerScript);
    if (existing) {
      const ownership = workerOwnership(existing, targetSocket);
      if (ownership === "same-target") {
        await waitForWorkerReadiness(targetSocket, {
          lookup: () => workerInfo(paths.pid, workerScript),
        });
        console.log(`Smart Rename already running (pid ${existing.pid})`);
        return;
      }
      if (ownership === "other-target") {
        throw new Error(
          `Smart Rename is already serving another Herdr session. Stop it there, then retry here:\n${otherSocketRecovery(existing.socket!)}`,
        );
      }
      throw new Error(
        "Smart Rename has a live legacy worker with unknown Herdr socket ownership. Stop it with `herdr plugin action invoke stop --plugin tab-smart-rename`, then retry start.",
      );
    }

    const logFd = openSync(paths.log, "a", 0o600);
    chmod(paths.log, 0o600, () => {});
    const child = Bun.spawn([process.execPath, workerScript], {
      cwd: root,
      env: process.env,
      detached: true,
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
    });
    child.unref();
    closeSync(logFd);
    await writeFile(
      paths.pid,
      `${JSON.stringify({
        pid: child.pid,
        script: workerScript,
        startedAt: new Date().toISOString(),
        socket: targetSocket,
      })}\n`,
      { mode: 0o600 },
    );
    await chmodAsync(paths.pid, 0o600);
    try {
      await waitForWorkerReadiness(targetSocket, {
        lookup: () => workerInfo(paths.pid, workerScript),
      });
    } catch (error) {
      child.kill();
      await rm(paths.pid, { force: true });
      throw error;
    }
    console.log(`Smart Rename started and ready (pid ${child.pid})`);
  } finally {
    await release();
  }
}

async function stop(): Promise<void> {
  const paths = statePaths(requireStateDir());
  const info = await workerInfo(paths.pid, workerScript);
  if (!info) {
    console.log("Smart Rename is not running");
    return;
  }
  if (workerOwnership(info, process.env.HERDR_SOCKET_PATH) === "other-target") {
    throw new Error("Smart Rename is serving another Herdr session and cannot be stopped from this session.");
  }
  process.kill(info.pid, "SIGTERM");
  for (let count = 0; count < 30; count += 1) {
    await Bun.sleep(100);
    if (!(await workerInfo(paths.pid, workerScript))) {
      console.log("Smart Rename stopped");
      return;
    }
  }
  throw new Error(`worker ${info.pid} did not stop`);
}

async function status(): Promise<void> {
  const paths = statePaths(requireStateDir());
  const info = await workerInfo(paths.pid, workerScript);
  if (!info) {
    console.log("Smart Rename stopped");
    return;
  }
  const ownership = workerOwnership(info, process.env.HERDR_SOCKET_PATH);
  const target = ownership === "same-target"
    ? "serving this Herdr session"
    : ownership === "other-target"
      ? "serving another Herdr session"
      : "with legacy-unknown Herdr socket ownership";
  console.log(`Smart Rename running (pid ${info.pid}, since ${info.startedAt}; ${target})`);
}

async function renameAll(): Promise<RenameResult[]> {
  const stateDir = requireStateDir();
  await ensurePrivateDir(stateDir);
  const service = createService({ stateDir });
  try {
    const initial = await service.initialize();
    const results = await service.evaluateAll(initial, {
      resetKind: "tab",
      forceRefresh: true,
    });
    console.log(JSON.stringify(results, null, 2));
    return results;
  } finally {
    await service.close();
  }
}

interface OnceOptions {
  resetKind?: "workspace" | "tab" | "pane" | null;
  forceRefresh?: boolean;
  dryRun?: boolean;
  progress?: boolean;
  targetPaneId?: string | null;
}

async function once({
  resetKind = null,
  forceRefresh = false,
  dryRun = false,
  progress = false,
  targetPaneId = null,
}: OnceOptions = {}): Promise<RenameResult | null> {
  const current = await snapshot();
  const paneId =
    resetKind === "pane"
      ? (targetPaneId ?? process.env.HERDR_PANE_ID ?? current.focused_pane_id)
      : undefined;
  const targetPane = paneId
    ? current.panes.find((pane) => pane.pane_id === paneId)
    : undefined;
  if (resetKind === "pane" && !targetPane) {
    throw new Error("No current Herdr pane");
  }
  const tabId =
    targetPane?.tab_id ?? process.env.HERDR_TAB_ID ?? current.focused_tab_id;
  const workspaceId =
    targetPane?.workspace_id ??
    process.env.HERDR_WORKSPACE_ID ??
    current.focused_workspace_id;
  if (!tabId || !workspaceId) throw new Error("No current Herdr tab/workspace");

  const stateDir = dryRun
    ? process.env.HERDR_PLUGIN_STATE_DIR
    : requireStateDir();
  if (stateDir) await ensurePrivateDir(stateDir);
  const service = createService({
    ...(stateDir ? { stateDir } : {}),
    ...(progress ? { modelActivity: beginTabProgress } : {}),
    dryRun,
  });
  try {
    await service.initialize(current);
    const targetTab =
      resetKind === "workspace"
        ? current.workspaces.find((item) => item.workspace_id === workspaceId)
            ?.active_tab_id || tabId
        : tabId;
    const result = await service.evaluate(targetTab, {
      snapshot: current,
      resetKind,
      ...(targetPane ? { targetPaneId: targetPane.pane_id } : {}),
      forceRefresh,
    });
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await service.close();
  }
}

async function openConfigPane(entrypoint: string): Promise<void> {
  await run(
    process.env.HERDR_BIN_PATH || "herdr",
    [
      "plugin",
      "pane",
      "open",
      "--plugin",
      "tab-smart-rename",
      "--entrypoint",
      entrypoint,
      "--placement",
      "overlay",
    ],
    { env: process.env },
  );
}

async function setup(): Promise<void> {
  await openConfigPane("setup");
}

async function configurePrompt(): Promise<void> {
  await openConfigPane("prompt-config");
}

export interface CheckAiDependencies {
  loadSelection?: (env: NodeJS.ProcessEnv) => Promise<ModelSelection>;
  loadPrompt?: (env: NodeJS.ProcessEnv) => Promise<string>;
  sourceFactory?: (
    selection: ModelSelection,
    env: NodeJS.ProcessEnv,
  ) => Promise<ModelSource>;
  notify?: typeof notify;
  report?: (summary: string) => void;
}

export async function checkAi(
  env: NodeJS.ProcessEnv = process.env,
  {
    loadSelection = (value) =>
      loadModelSelection(value.HERDR_PLUGIN_CONFIG_DIR, value),
    loadPrompt = loadNamingPrompt,
    sourceFactory = loadModelSource,
    notify: sendNotice = notify,
    report = console.log,
  }: CheckAiDependencies = {},
): Promise<string> {
  const selection = await loadSelection(env);
  const source = await sourceFactory(selection, env);
  try {
    await Promise.all([source.validate(selection), loadPrompt(env)]);
    const config = selection.source === "direct" ? await loadProviderConfig(env) : undefined;
    const summary = config ? `${config.provider}/${config.model}` : selectionLabel(selection);
    await sendNotice("AI ready", summary);
    report(summary);
    return summary;
  } catch (error) {
    const message = errorMessage(error);
    await sendNotice("AI config needs attention", message, "request");
    throw error;
  } finally {
    await source.close?.();
  }
}

async function renameNow(): Promise<void> {
  await notify("Renaming tab");
  const result = await once({
    resetKind: "tab",
    forceRefresh: true,
    progress: true,
  });
  if (result?.outcomes?.some((item) => item.status === "failed"))
    process.exitCode = 1;
  const notice = currentResultNotice(result);
  await notify(notice.title, notice.body, notice.sound);
}

async function renameEveryTab(): Promise<void> {
  await notify("Renaming tabs");
  const results = await renameAll();
  const renamed = renamedTabCount(results);
  const failed = results.filter((result) =>
    result.outcomes?.some((item) => item.status === "failed"),
  ).length;
  if (failed) process.exitCode = 1;
  await notify(
    failed
      ? "Some renames failed"
      : renamed
        ? "Tabs renamed"
        : "No tabs renamed",
    `${renamed}/${results.length}${failed ? `, ${failed} failed` : ""}`,
    failed || !renamed ? "request" : "done",
  );
}

interface DispatchOptions {
  dryRun?: boolean;
  actions?: Record<string, (options: { dryRun: boolean }) => unknown>;
}

const defaultActions: NonNullable<DispatchOptions["actions"]> = {
  start,
  stop,
  status,
  setup,
  "configure-ai": setup,
  "configure-prompt": configurePrompt,
  "check-ai": () => checkAi(),
  once: ({ dryRun }) => once({ dryRun }),
  "dry-run": () => once({ dryRun: true }),
  "rename-now": renameNow,
  all: renameEveryTab,
  "reset-tab": () => once({ resetKind: "tab", forceRefresh: true }),
  "reset-workspace": () => once({ resetKind: "workspace", forceRefresh: true }),
  "reset-pane": () => once({ resetKind: "pane", forceRefresh: true }),
};

export async function dispatch(
  command: string | undefined,
  { dryRun = false, actions = defaultActions }: DispatchOptions = {},
): Promise<unknown> {
  const action = command ? actions[command] : undefined;
  if (!action) {
    throw new Error(
      "usage: cli.ts start|stop|status|setup|configure-prompt|check-ai|once [--dry-run]|dry-run|rename-now|all|reset-tab|reset-pane|reset-workspace",
    );
  }
  return action({ dryRun });
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  try {
    const result = await dispatch(command, {
      dryRun: argv.includes("--dry-run"),
    });
    if (
      result &&
      typeof result === "object" &&
      "outcomes" in result &&
      Array.isArray(result.outcomes)
    ) {
      if (result.outcomes.some((outcome) => outcome.status === "failed"))
        process.exitCode = 1;
    }
  } catch (error) {
    const message = errorMessage(error);
    if (command === "rename-now" || command === "all") {
      await notify("Rename failed", message, "request");
    }
    console.error(`Smart Rename: ${message}`);
    process.exitCode = 1;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) await main();
