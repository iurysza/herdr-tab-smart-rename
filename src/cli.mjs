#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, openSync, closeSync } from "node:fs";
import { chmod as chmodAsync, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PiRpc, snapshot } from "./integrations.mjs";
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
      console.log(`AutoName already running (pid ${existing.pid})`);
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
    console.log(`AutoName started (pid ${child.pid})`);
  } finally {
    await release();
  }
}

async function stop() {
  const paths = statePaths(requireStateDir());
  const info = await workerInfo(paths.pid, workerScript);
  if (!info) {
    console.log("AutoName is not running");
    return;
  }
  process.kill(info.pid, "SIGTERM");
  for (let count = 0; count < 30; count += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!(await workerInfo(paths.pid, workerScript))) {
      console.log("AutoName stopped");
      return;
    }
  }
  throw new Error(`worker ${info.pid} did not stop`);
}

async function status() {
  const paths = statePaths(requireStateDir());
  const info = await workerInfo(paths.pid, workerScript);
  if (!info) {
    console.log("AutoName stopped");
    return;
  }
  console.log(`AutoName running (pid ${info.pid}, since ${info.startedAt})`);
}

async function once(resetKind = null) {
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
  const pi = new PiRpc(process.env);
  const service = new AutoNameService({
    stateFile: paths?.state ?? null,
    stateLock: paths?.stateLock ?? null,
    pi,
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
      forceModel: resetKind === "tab",
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    pi.close();
  }
}

try {
  if (command === "start") await start();
  else if (command === "stop") await stop();
  else if (command === "status") await status();
  else if (
    command === "once" ||
    command === "rename-now" ||
    command === "dry-run"
  ) {
    await once();
  } else if (command === "reset-tab") await once("tab");
  else if (command === "reset-workspace") await once("workspace");
  else {
    throw new Error(
      "usage: cli.mjs start|stop|status|once [--dry-run]|dry-run|reset-tab|reset-workspace",
    );
  }
} catch (error) {
  console.error(`AutoName: ${error.message}`);
  process.exitCode = 1;
}
