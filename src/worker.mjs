#!/usr/bin/env node
import { appendFile, chmod, readFile, rm } from "node:fs/promises";
import { createService } from "./app.mjs";
import { snapshot, subscribe } from "./integrations.mjs";
import { ensurePrivateDir, statePaths } from "./service.mjs";

export const SWEEP_INTERVAL_MS = 60_000;

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
if (!stateDir) throw new Error("HERDR_PLUGIN_STATE_DIR is required");
await ensurePrivateDir(stateDir);
const paths = statePaths(stateDir);

async function log(message) {
  await appendFile(paths.log, `${new Date().toISOString()} ${message}\n`, {
    mode: 0o600,
  }).catch(() => {});
  await chmod(paths.log, 0o600).catch(() => {});
}

const service = createService({ stateDir });
await service.initialize();

let socket = null;
let stopped = false;
let reconnectTimer = null;
let sweepTimer = null;
let work = Promise.resolve();
let sweepQueued = false;
const timers = new Map();

function enqueue(task) {
  work = work
    .then(task, task)
    .catch((error) => log(`task failed: ${error.message}`));
  return work;
}

async function evaluate(tabId, snap = null) {
  if (!tabId || stopped) return;
  const result = await service.evaluate(tabId, snap ? { snapshot: snap } : {});
  if (result?.changes.length) {
    await log(`renamed ${JSON.stringify(result.changes)}`);
  }
}

function schedule(tabId, delay = 400) {
  if (!tabId || stopped) return;
  clearTimeout(timers.get(tabId));
  const timer = setTimeout(() => {
    timers.delete(tabId);
    enqueue(() => evaluate(tabId));
  }, delay);
  timers.set(tabId, timer);
}

async function sweep() {
  if (stopped) return;
  const snap = await snapshot();
  for (const tab of snap.tabs) {
    await evaluate(tab.tab_id);
  }
}

function queueSweep() {
  if (stopped || sweepQueued) return;
  sweepQueued = true;
  enqueue(async () => {
    try {
      await sweep();
    } finally {
      sweepQueued = false;
    }
  });
}

async function handleEvent(event) {
  if (event.type === "workspace_renamed") {
    await service.acknowledge("workspace", event.workspace_id, event.label);
    return;
  }
  if (event.type === "tab_renamed") {
    await service.acknowledge("tab", event.tab_id, event.label);
    return;
  }
  if (event.type === "tab_closed" || event.type === "workspace_closed") return;

  const snap = await snapshot();
  const pane = event.pane_id
    ? snap.panes.find((item) => item.pane_id === event.pane_id)
    : null;
  const workspaceId =
    event.workspace_id || event.workspace?.workspace_id || pane?.workspace_id;
  const workspace = workspaceId
    ? snap.workspaces.find((item) => item.workspace_id === workspaceId)
    : null;
  const tabId =
    event.tab_id ||
    event.tab?.tab_id ||
    event.pane?.tab_id ||
    pane?.tab_id ||
    workspace?.active_tab_id;
  schedule(tabId);
}

function scheduleReconnect(delay) {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (stopped) return;
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!socketPath) {
    log("HERDR_SOCKET_PATH is required; retrying");
    scheduleReconnect(5_000);
    return;
  }
  const connection = subscribe(socketPath, (event) => {
    enqueue(() => handleEvent(event));
  });
  socket = connection;
  connection.on("error", (error) => log(`socket error: ${error.message}`));
  connection.on("close", () => {
    if (socket !== connection) return;
    socket = null;
    scheduleReconnect(1_000);
  });
}

async function shutdown(signal) {
  if (stopped) return;
  stopped = true;
  clearTimeout(reconnectTimer);
  clearInterval(sweepTimer);
  for (const timer of timers.values()) clearTimeout(timer);
  socket?.destroy();
  await work.catch(() => {});
  try {
    const info = JSON.parse(await readFile(paths.pid, "utf8"));
    if (info.pid === process.pid) await rm(paths.pid, { force: true });
  } catch {
    // The owner may already have removed a stale PID file.
  }
  await log(`stopped by ${signal}`);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", async (error) => {
  await log(`fatal: ${error.stack ?? error}`);
  await shutdown("error");
});
process.on("unhandledRejection", async (error) => {
  await log(`fatal rejection: ${error?.stack ?? error}`);
  await shutdown("error");
});

await log(`started pid=${process.pid}`);
queueSweep();
sweepTimer = setInterval(queueSweep, SWEEP_INTERVAL_MS);
connect();
