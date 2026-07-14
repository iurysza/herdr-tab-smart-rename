#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, closeSync, openSync } from "node:fs";
import { chmod as chmodAsync, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createService } from "./app.mjs";
import { sanitize } from "./core.mjs";
import { run, snapshot } from "./integrations.mjs";
import { loadProviderConfig } from "./provider.mjs";
import { ensurePrivateDir, statePaths } from "./service.mjs";
import { acquireLock, workerInfo } from "./singleton.mjs";

const root =
  process.env.HERDR_PLUGIN_ROOT ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerScript = path.join(root, "src", "worker.mjs");

function requireStateDir() {
  if (!process.env.HERDR_PLUGIN_STATE_DIR) {
    throw new Error(
      "HERDR_PLUGIN_STATE_DIR is required (Herdr sets it for plugin actions)",
    );
  }
  return process.env.HERDR_PLUGIN_STATE_DIR;
}

async function notify(title, body = "", sound = "none") {
  const args = ["notification", "show", title];
  const safeBody = sanitize(body).slice(0, 120);
  if (safeBody) args.push("--body", safeBody);
  args.push("--position", "bottom-right", "--sound", sound);
  await run(process.env.HERDR_BIN_PATH || "herdr", args, {
    env: process.env,
    timeout: 3_000,
  }).catch(() => {});
}

function currentResultNotice(result) {
  const change = result?.changes.find((item) => item.kind === "tab");
  if (change) {
    return { title: "Tab renamed", body: `${change.from} -> ${change.to}` };
  }
  const reason = String(result?.reason ?? "");
  const body = reason.includes("meaningful task")
    ? "No task found"
    : "Name unchanged";
  return { title: "No change", body };
}

async function start() {
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
    const child = spawn(process.execPath, [workerScript], {
      cwd: root,
      env: process.env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
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

async function stop() {
  const paths = statePaths(requireStateDir());
  const info = await workerInfo(paths.pid, workerScript);
  if (!info) {
    console.log("Smart Rename is not running");
    return;
  }
  process.kill(info.pid, "SIGTERM");
  for (let count = 0; count < 30; count += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!(await workerInfo(paths.pid, workerScript))) {
      console.log("Smart Rename stopped");
      return;
    }
  }
  throw new Error(`worker ${info.pid} did not stop`);
}

async function status() {
  const paths = statePaths(requireStateDir());
  const info = await workerInfo(paths.pid, workerScript);
  if (!info) {
    console.log("Smart Rename stopped");
    return;
  }
  console.log(`Smart Rename running (pid ${info.pid}, since ${info.startedAt})`);
}

async function renameAll() {
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

async function once(resetKind = null, forceRefresh = false, dryRun = false) {
  const snap = await snapshot();
  const tabId = process.env.HERDR_TAB_ID || snap.focused_tab_id;
  const workspaceId =
    process.env.HERDR_WORKSPACE_ID || snap.focused_workspace_id;
  if (!tabId || !workspaceId) throw new Error("No current Herdr tab/workspace");

  const stateDir = dryRun
    ? process.env.HERDR_PLUGIN_STATE_DIR
    : requireStateDir();
  if (stateDir) await ensurePrivateDir(stateDir);
  const service = createService({ stateDir, dryRun });
  await service.initialize(snap);
  const targetTab =
    resetKind === "workspace"
      ? snap.workspaces.find((item) => item.workspace_id === workspaceId)
          ?.active_tab_id || tabId
      : tabId;
  const result = await service.evaluate(targetTab, {
    snapshot: snap,
    resetKind,
    forceRefresh,
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function configureAi() {
  await run(
    process.env.HERDR_BIN_PATH || "herdr",
    [
      "plugin",
      "pane",
      "open",
      "--plugin",
      "autoname",
      "--entrypoint",
      "provider-config",
      "--placement",
      "overlay",
    ],
    { env: process.env },
  );
}

async function checkAi() {
  try {
    const config = await loadProviderConfig(process.env);
    const summary = `${config.provider}/${config.model}`;
    await notify("AI ready", summary);
    console.log(summary);
  } catch (error) {
    await notify("Config missing", error.message, "request");
    throw error;
  }
}

async function renameNow() {
  await notify("Renaming tab");
  const result = await once("tab", true);
  const notice = currentResultNotice(result);
  await notify(notice.title, notice.body);
}

async function renameEveryTab() {
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

const defaultActions = {
  start,
  stop,
  status,
  "configure-ai": configureAi,
  "check-ai": checkAi,
  once: ({ dryRun }) => once(null, false, dryRun),
  "dry-run": () => once(null, false, true),
  "rename-now": renameNow,
  all: renameEveryTab,
  "reset-tab": () => once("tab", true),
  "reset-workspace": () => once("workspace", true),
};

/**
 * Dispatch one CLI action without executing at module import time.
 *
 * @param {string} command
 * @param {{dryRun?: boolean, actions?: Record<string, Function>}} options
 */
export async function dispatch(
  command,
  { dryRun = false, actions = defaultActions } = {},
) {
  const action = actions[command];
  if (!action) {
    throw new Error(
      "usage: cli.mjs start|stop|status|configure-ai|check-ai|once [--dry-run]|dry-run|rename-now|all|reset-tab|reset-workspace",
    );
  }
  return action({ dryRun });
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  try {
    await dispatch(command, { dryRun: argv.includes("--dry-run") });
  } catch (error) {
    if (command === "rename-now" || command === "all") {
      await notify("Rename failed", error.message, "request");
    }
    console.error(`Smart Rename: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
