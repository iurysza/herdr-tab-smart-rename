#!/usr/bin/env bun
import { appendFile, chmod } from "node:fs/promises";
import { type Socket } from "node:net";
import {
  snapshot,
  subscribe,
  tabProgressBase,
  type HerdrEvent,
  type HerdrSnapshot,
} from "./herdr.ts";
import { createService } from "./service.ts";
import {
  ensurePrivateDir,
  removeOwnedWorkerPid,
  statePaths,
} from "./storage.ts";

export const SWEEP_INTERVAL_MS = 60_000;

export function shouldIgnoreProgressRename(
  progressBases: Map<string, string>,
  tabId: string,
  label: string,
): boolean {
  const progressBase = tabProgressBase(label);
  if (progressBase !== null) {
    progressBases.set(tabId, progressBase);
    return true;
  }
  const restoring = progressBases.get(tabId);
  progressBases.delete(tabId);
  return restoring === label;
}

export async function runWorker(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const stateDir = env.HERDR_PLUGIN_STATE_DIR;
  if (!stateDir) throw new Error("HERDR_PLUGIN_STATE_DIR is required");
  await ensurePrivateDir(stateDir);
  const paths = statePaths(stateDir);
  const service = createService({ stateDir, env });

  const log = async (message: string): Promise<void> => {
    await appendFile(paths.log, `${new Date().toISOString()} ${message}\n`, {
      mode: 0o600,
    }).catch(() => {});
    await chmod(paths.log, 0o600).catch(() => {});
  };

  await service.initialize();

  let socket: Socket | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let work = Promise.resolve();
  let sweepQueued = false;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const progressBases = new Map<string, string>();

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    work = work
      .then(task, task)
      .catch((error: unknown) => log(`task failed: ${errorMessage(error)}`));
    return work;
  };

  const evaluate = async (
    tabId: string | undefined,
    current?: HerdrSnapshot,
  ): Promise<void> => {
    if (!tabId || stopped) return;
    const result = await service.evaluate(
      tabId,
      current ? { snapshot: current } : {},
    );
    if (result?.changes.length) {
      await log(`renamed ${JSON.stringify(result.changes)}`);
    }
  };

  const schedule = (tabId: string | undefined, delay = 400): void => {
    if (!tabId || stopped) return;
    const previous = timers.get(tabId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      timers.delete(tabId);
      enqueue(() => evaluate(tabId));
    }, delay);
    timers.set(tabId, timer);
  };

  const sweep = async (): Promise<void> => {
    if (stopped) return;
    const current = await snapshot(env);
    for (const tab of current.tabs) await evaluate(tab.tab_id);
  };

  const queueSweep = (): void => {
    if (stopped || sweepQueued) return;
    sweepQueued = true;
    enqueue(async () => {
      try {
        await sweep();
      } finally {
        sweepQueued = false;
      }
    });
  };

  const handleEvent = async (event: HerdrEvent): Promise<void> => {
    if (event.type === "workspace_renamed" && event.workspace_id && event.label) {
      await service.acknowledge("workspace", event.workspace_id, event.label);
      return;
    }
    if (event.type === "tab_renamed" && event.tab_id && event.label) {
      if (shouldIgnoreProgressRename(progressBases, event.tab_id, event.label)) {
        return;
      }
      await service.acknowledge("tab", event.tab_id, event.label);
      return;
    }
    if (event.type === "tab_closed") {
      if (event.tab_id) progressBases.delete(event.tab_id);
      return;
    }
    if (event.type === "workspace_closed") return;

    const current = await snapshot(env);
    const pane = event.pane_id
      ? current.panes.find((item) => item.pane_id === event.pane_id)
      : undefined;
    const workspaceId =
      event.workspace_id || event.workspace?.workspace_id || pane?.workspace_id;
    const workspace = workspaceId
      ? current.workspaces.find((item) => item.workspace_id === workspaceId)
      : undefined;
    const tabId =
      event.tab_id ||
      event.tab?.tab_id ||
      event.pane?.tab_id ||
      pane?.tab_id ||
      workspace?.active_tab_id;
    schedule(tabId);
  };

  const scheduleReconnect = (delay: number): void => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };

  const connect = (): void => {
    if (stopped) return;
    const socketPath = env.HERDR_SOCKET_PATH;
    if (!socketPath) {
      void log("HERDR_SOCKET_PATH is required; retrying");
      scheduleReconnect(5_000);
      return;
    }
    const connection = subscribe(socketPath, (event) => {
      enqueue(() => handleEvent(event));
    });
    socket = connection;
    connection.on("error", (error) => void log(`socket error: ${error.message}`));
    connection.on("close", () => {
      if (socket !== connection) return;
      socket = null;
      scheduleReconnect(1_000);
    });
  };

  const shutdown = async (signal: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (sweepTimer) clearInterval(sweepTimer);
    for (const timer of timers.values()) clearTimeout(timer);
    socket?.destroy();
    await work.catch(() => {});
    await removeOwnedWorkerPid(paths.pid, process.pid);
    await log(`stopped by ${signal}`);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("uncaughtException", (error) => {
    void log(`fatal: ${error.stack ?? error}`).then(() => shutdown("error"));
  });
  process.on("unhandledRejection", (error) => {
    void log(`fatal rejection: ${errorMessage(error)}`).then(() =>
      shutdown("error"),
    );
  });

  await log(`started pid=${process.pid}`);
  queueSweep();
  sweepTimer = setInterval(queueSweep, SWEEP_INTERVAL_MS);
  connect();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) await runWorker();
