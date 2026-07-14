#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, openSync, closeSync } from "node:fs";
import { chmod as chmodAsync, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitize } from "./core.mjs";
import { run, snapshot } from "./integrations.mjs";
import { AiSdkNamer, loadProviderConfig } from "./provider.mjs";
import {
  AutoNameService,
  ensurePrivateDir,
  statePaths,
} from "./service.mjs";
import { acquireLock, workerInfo } from "./singleton.mjs";

const command = process.argv[2];
const dryRun = command === "dry-run" || process.argv.includes("--dry-run");
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
  const paths = statePaths(stateDir);
  const namer = new AiSdkNamer(process.env);
  const service = new AutoNameService({
    stateFile: paths.state,
    stateLock: paths.stateLock,
    namer,
  });
  try {
    const initial = await service.initialize();
    const results = await service.evaluateAll(initial, {
      resetKind: "tab",
      forceRefresh: true,
    });
    console.log(JSON.stringify(results, null, 2));
    return results;
  } finally {
    namer.close();
  }
}

async function once(resetKind = null, forceRefresh = false) {
  const snap = await snapshot();
  const tabId = process.env.HERDR_TAB_ID || snap.focused_tab_id;
  const workspaceId =
    process.env.HERDR_WORKSPACE_ID || snap.focused_workspace_id;
  if (!tabId || !workspaceId) throw new Error("No current Herdr tab/workspace");

  const stateDir = dryRun
    ? process.env.HERDR_PLUGIN_STATE_DIR
    : requireStateDir();
  if (stateDir) await ensurePrivateDir(stateDir);
  const paths = stateDir ? statePaths(stateDir) : null;
  const namer = new AiSdkNamer(process.env);
  const service = new AutoNameService({
    stateFile: paths?.state ?? null,
    stateLock: paths?.stateLock ?? null,
    namer,
    dryRun,
  });
  try {
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
  } finally {
    namer.close();
  }
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

try {
  if (command === "start") await start();
  else if (command === "stop") await stop();
  else if (command === "status") await status();
  else if (command === "configure-ai") await configureAi();
  else if (command === "check-ai") await checkAi();
  else if (command === "once" || command === "dry-run") await once();
  else if (command === "rename-now") {
    await notify("Renaming tab");
    const result = await once("tab", true);
    const notice = currentResultNotice(result);
    await notify(notice.title, notice.body);
  } else if (command === "all") {
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
  else if (command === "reset-tab") await once("tab", true);
  else if (command === "reset-workspace") await once("workspace", true);
  else {
    throw new Error(
      "usage: cli.mjs start|stop|status|configure-ai|check-ai|once [--dry-run]|dry-run|rename-now|all|reset-tab|reset-workspace",
    );
  }
} catch (error) {
  if (command === "rename-now" || command === "all") {
    await notify("Rename failed", error.message, "request");
  }
  console.error(`Smart Rename: ${error.message}`);
  process.exitCode = 1;
}
