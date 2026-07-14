#!/usr/bin/env bun
import { chmod, closeSync, openSync } from "node:fs";
import { chmod as chmodAsync, writeFile } from "node:fs/promises";
import path from "node:path";
import { type RenameResult } from "./domain.ts";
import { run, snapshot } from "./herdr.ts";
import { loadNamingPrompt, loadProviderConfig } from "./provider.ts";
import { createService } from "./service.ts";
import {
  acquireLock,
  ensurePrivateDir,
  statePaths,
  workerInfo,
} from "./storage.ts";
import { sanitizeText } from "./text.ts";

const root = process.env.HERDR_PLUGIN_ROOT || path.resolve(import.meta.dir, "..");
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
  sound: "none" | "request" = "none",
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

function currentResultNotice(result: RenameResult | null): {
  title: string;
  body: string;
} {
  const change = result?.changes.find((item) => item.kind === "tab");
  if (change) {
    return { title: "Tab renamed", body: `${change.from} -> ${change.to}` };
  }
  const body = result?.reason.includes("meaningful task")
    ? "No task found"
    : "Name unchanged";
  return { title: "No change", body };
}

async function start(): Promise<void> {
  const stateDir = requireStateDir();
  await ensurePrivateDir(stateDir);
  const paths = statePaths(stateDir);
  const release = await acquireLock(paths.startLock, {
    timeoutMs: 2_000,
    staleMs: 30_000,
  });
  try {
    const existing = await workerInfo(paths.pid, workerScript);
    if (existing) {
      console.log(`Smart Rename already running (pid ${existing.pid})`);
      return;
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
      })}\n`,
      { mode: 0o600 },
    );
    await chmodAsync(paths.pid, 0o600);
    console.log(`Smart Rename started (pid ${child.pid})`);
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
  console.log(`Smart Rename running (pid ${info.pid}, since ${info.startedAt})`);
}

async function renameAll(): Promise<RenameResult[]> {
  const stateDir = requireStateDir();
  await ensurePrivateDir(stateDir);
  const service = createService({ stateDir });
  const initial = await service.initialize();
  const results = await service.evaluateAll(initial, {
    resetKind: "tab",
    forceRefresh: true,
  });
  console.log(JSON.stringify(results, null, 2));
  return results;
}

async function once(
  resetKind: "workspace" | "tab" | null = null,
  forceRefresh = false,
  dryRun = false,
): Promise<RenameResult | null> {
  const current = await snapshot();
  const tabId = process.env.HERDR_TAB_ID || current.focused_tab_id;
  const workspaceId =
    process.env.HERDR_WORKSPACE_ID || current.focused_workspace_id;
  if (!tabId || !workspaceId) throw new Error("No current Herdr tab/workspace");

  const stateDir = dryRun
    ? process.env.HERDR_PLUGIN_STATE_DIR
    : requireStateDir();
  if (stateDir) await ensurePrivateDir(stateDir);
  const service = createService({
    ...(stateDir ? { stateDir } : {}),
    dryRun,
  });
  await service.initialize(current);
  const targetTab =
    resetKind === "workspace"
      ? current.workspaces.find((item) => item.workspace_id === workspaceId)
          ?.active_tab_id || tabId
      : tabId;
  const result = await service.evaluate(targetTab, {
    snapshot: current,
    resetKind,
    forceRefresh,
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
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

async function configureAi(): Promise<void> {
  await openConfigPane("provider-config");
}

async function configurePrompt(): Promise<void> {
  await openConfigPane("prompt-config");
}

async function checkAi(): Promise<void> {
  try {
    const config = await loadProviderConfig(process.env);
    await loadNamingPrompt(config, process.env);
    const summary = `${config.provider}/${config.model}`;
    await notify("AI ready", summary);
    console.log(summary);
  } catch (error) {
    const message = errorMessage(error);
    await notify("Config missing", message, "request");
    throw error;
  }
}

async function renameNow(): Promise<void> {
  await notify("Renaming tab");
  const notice = currentResultNotice(await once("tab", true));
  await notify(notice.title, notice.body);
}

async function renameEveryTab(): Promise<void> {
  await notify("Renaming tabs");
  const results = await renameAll();
  const renamed = results.reduce(
    (count, result) =>
      count + result.changes.filter((item) => item.kind === "tab").length,
    0,
  );
  await notify(
    renamed ? "Tabs renamed" : "No changes",
    `${renamed}/${results.length}`,
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
  "configure-ai": configureAi,
  "configure-prompt": configurePrompt,
  "check-ai": checkAi,
  once: ({ dryRun }) => once(null, false, dryRun),
  "dry-run": () => once(null, false, true),
  "rename-now": renameNow,
  all: renameEveryTab,
  "reset-tab": () => once("tab", true),
  "reset-workspace": () => once("workspace", true),
};

export async function dispatch(
  command: string | undefined,
  { dryRun = false, actions = defaultActions }: DispatchOptions = {},
): Promise<unknown> {
  const action = command ? actions[command] : undefined;
  if (!action) {
    throw new Error(
      "usage: cli.ts start|stop|status|configure-ai|configure-prompt|check-ai|once [--dry-run]|dry-run|rename-now|all|reset-tab|reset-workspace",
    );
  }
  return action({ dryRun });
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  try {
    await dispatch(command, { dryRun: argv.includes("--dry-run") });
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
