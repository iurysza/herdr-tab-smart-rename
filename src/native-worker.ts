#!/usr/bin/env bun
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  createNativeService, discoverNativeTargets, NativeTargetError,
  type NativeCommand, type NativeService, type NativeServiceOptions,
} from "./herdr-app.ts";
import { nativeOptions } from "./herdr-app-cli.ts";
import { ModelSourceNamer } from "./model-namer.ts";
import type { Namer } from "./provider.ts";
import { MAX_CONCURRENT_TABS } from "./service.ts";
import { acquireLock, ensurePrivateDir } from "./storage.ts";

export const NATIVE_DEBOUNCE_MS = 400;

export const NATIVE_RECOVERY_MS = 60_000;

export interface NativeWorkerStatus {
  version: 1;
  pid: number;
  state: "starting" | "ready" | "waiting" | "stopping" | "failed";
  managedTabs: number;
  updatedAt: string;
  detail?: string;
}

// The event transport is the only long-lived child, never one child per tab.
export type NativeEvents = (env: NodeJS.ProcessEnv, signal: AbortSignal) => AsyncIterable<unknown>;

export async function* nativeEvents(env: NodeJS.ProcessEnv, signal: AbortSignal): AsyncIterable<unknown> {
  if (signal.aborted) return;

  const child = Bun.spawn([env.HC_BIN_PATH || "hc", "events", "--json"], {
    env, stdin: "ignore", stdout: "pipe", stderr: "ignore",
  });

  const stop = () => { child.kill(); };

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  signal.addEventListener("abort", stop, { once: true });

  try {
    if (signal.aborted) stop();

    while (!signal.aborted) {
      const chunk = await reader.read();

      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim()) yield JSON.parse(line);
      }
    }
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
    reader.releaseLock();
    await child.exited;
  }
}

export interface NativeWorkerOptions {
  configDir: string;
  runtimeDir: string;
  env?: NodeJS.ProcessEnv;
  command?: NativeCommand;
  namer?: Namer;
  events?: NativeEvents;
}

export function nativeWorkerOptions(args: string[], env: NodeJS.ProcessEnv = process.env): NativeWorkerOptions {
  const { values, positionals } = parseArgs({ args, options: {
    "config-dir": { type: "string" }, "runtime-dir": { type: "string" },
  } });

  const configDir = values["config-dir"];
  const runtimeDir = values["runtime-dir"];

  if (positionals.length || !configDir || !runtimeDir || !path.isAbsolute(configDir) || !path.isAbsolute(runtimeDir))
    throw new Error("usage: native-worker.ts --config-dir ABSOLUTE_DIRECTORY --runtime-dir ABSOLUTE_DIRECTORY");

  return { configDir, runtimeDir, env };
}

type ManagedTarget = {
  native?: NativeService;
  release?: () => Promise<void>;
  state: "active" | "waiting" | "blocked";
};

export async function runNativeWorker(options: NativeWorkerOptions, signal: AbortSignal): Promise<void> {
  if (!path.isAbsolute(options.configDir) || !path.isAbsolute(options.runtimeDir))
    throw new Error("Native config and runtime directories must be absolute");
  const env = { ...(options.env ?? process.env), HERDR_PLUGIN_CONFIG_DIR: options.configDir };

  await ensurePrivateDir(options.runtimeDir);
  const releaseSupervisor = await acquireLock(path.join(options.runtimeDir, "supervisor.lock"), { timeoutMs: 0 });
  const namer = options.namer ?? new ModelSourceNamer(env);
  // Individual services borrow the source. Only this runtime may close it.
  const borrowedNamer: Namer = { suggest: (context) => namer.suggest(context) };
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener("abort", stop, { once: true });

  if (signal.aborted) stop();
  const targets = new Map<string, ManagedTarget>();
  const waiting: string[] = [];
  const running = new Set<string>();
  const rerun = new Set<string>();
  const tasks = new Set<Promise<void>>();
  let connected = false;
  let discovered = false;
  let failure: Error | undefined;
  let statusWork = Promise.resolve();
  let refreshWork = Promise.resolve();
  let refreshRunning = false;
  let refreshAgain = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let recovery: ReturnType<typeof setInterval> | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;

  const publish = (state?: NativeWorkerStatus["state"]): Promise<void> => {
    const paused = [...targets.values()].some((target) => target.state !== "active");

    const status: NativeWorkerStatus = {
      version: 1, pid: process.pid,
      state: state ?? (connected && discovered && !paused ? "ready" : "waiting"),
      managedTabs: [...targets.values()].filter((target) => target.release).length,
      updatedAt: new Date().toISOString(),
    };

    if (paused) status.detail = "Some native targets are waiting or blocked";
    const file = path.join(options.runtimeDir, "status.json");
    const temporary = `${file}.${process.pid}.tmp`;

    statusWork = statusWork.then(async () => {
      try {
        await writeFile(temporary, `${JSON.stringify(status)}\n`, { mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    }).catch(() => {
      failure = new Error("Cannot write native runtime status");
      stop();
    });

    return statusWork;
  };

  const retire = async (id: string, target: ManagedTarget): Promise<void> => {
    await target.native?.service.close();
    await target.release?.();
    targets.delete(id);
    rerun.delete(id);
  };

  const evaluate = async (id: string): Promise<void> => {
    const target = targets.get(id);

    if (!target || target.state === "blocked" || controller.signal.aborted) return;

    try {
      if (!target.native) {
        const derived = nativeOptions(["watch", "--tab", id], env);
        const serviceOptions: NativeServiceOptions = { ...derived, namer: borrowedNamer };

        if (options.command) serviceOptions.command = options.command;
        target.native = await createNativeService(serviceOptions);
      }

      // Retain the bound service through contention as well as outages. Resolving
      // it again after a busy lock could silently adopt a replacement remote core.
      target.release ??= await acquireLock(path.join(target.native.stateDir, "watch.lock"), { timeoutMs: 0 });
      const result = await target.native.service.evaluate(id);

      if (!result) await retire(id, target);
      else target.state = result.outcomes?.some((outcome) => outcome.status === "failed") ? "waiting" : "active";
    } catch (error) {
      // Never rebind a changed core during this target's lifetime. Keep its
      // original service and lock; other tabs continue independently.
      target.state = error instanceof NativeTargetError && error.kind !== "unavailable" ? "blocked" : "waiting";
    }

    await publish();
  };

  const pump = (): void => {
    while (!controller.signal.aborted && running.size < MAX_CONCURRENT_TABS && waiting.length) {
      const id = waiting.shift()!;
      running.add(id);

      const task = evaluate(id).finally(() => {
        running.delete(id);
        tasks.delete(task);

        if (rerun.delete(id) && targets.has(id)) request(id);
        pump();
      });

      tasks.add(task);
    }
  };

  const request = (id: string): void => {
    if (controller.signal.aborted || targets.get(id)?.state === "blocked") return;

    if (running.has(id)) rerun.add(id);
    else if (!waiting.includes(id)) waiting.push(id);
    pump();
  };

  const refresh = (): void => {
    if (controller.signal.aborted) return;

    if (refreshRunning) {
      refreshAgain = true;

      return;
    }

    refreshRunning = true;
    refreshWork = (async () => {
      try {
        const found = await discoverNativeTargets(env, options.command);
        discovered = true;

        for (const target of found) {
          if (!targets.has(target.id)) targets.set(target.id, { state: "waiting" });
        }
      } catch {
        // Failed discovery is not deletion. Bound services must verify closure.
        discovered = false;
      }

      for (const id of targets.keys()) request(id);
      await publish();
    })().finally(() => {
      refreshRunning = false;

      if (refreshAgain) { refreshAgain = false; refresh(); }
    });
  };

  const schedule = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(refresh, NATIVE_DEBOUNCE_MS);
  };

  try {
    await publish("starting");
    refresh();
    recovery = setInterval(refresh, NATIVE_RECOVERY_MS);

    while (!controller.signal.aborted) {
      try {
        for await (const event of (options.events ?? nativeEvents)(env, controller.signal)) {
          if (controller.signal.aborted) break;
          const wasConnected = connected;
          connected = true;

          if (!wasConnected) { refresh(); await publish(); }

          // Heartbeats establish transport health but contain no naming evidence.
          if (!JSON.stringify(event)?.includes('"heartbeat"')) schedule();
        }
      } catch {
        // App/core and transport restarts are normal for an installed service.
      }

      connected = false;

      if (controller.signal.aborted) break;
      await publish();
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(reconnect); controller.signal.removeEventListener("abort", finish); resolve(); };

        controller.signal.addEventListener("abort", finish, { once: true });
        reconnect = setTimeout(finish, 1_000);

        if (controller.signal.aborted) finish();
      });
    }
  } finally {
    stop();
    signal.removeEventListener("abort", stop);

    if (debounce) clearTimeout(debounce);

    if (recovery) clearInterval(recovery);

    if (reconnect) clearTimeout(reconnect);
    await refreshWork;
    await publish(failure ? "failed" : "stopping");
    await Promise.allSettled(tasks);

    try {
      const cleanup = await Promise.allSettled([...targets.values()].map(async (target) => {
        try { await target.native?.service.close(); } finally { await target.release?.(); }
      }));

      try { await namer.close?.(); } catch { failure = new Error("Cannot close native runtime source"); }

      if (cleanup.some((result) => result.status === "rejected")) failure = new Error("Cannot release native target resources");
      targets.clear();
      await publish(failure ? "failed" : "stopping");
    } finally {
      await releaseSupervisor();
    }
  }

  if (failure) throw failure;
}

export async function nativeWorkerMain(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const options = nativeWorkerOptions(args, env);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try { await runNativeWorker(options, controller.signal); }
  finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (import.meta.main) {
  await nativeWorkerMain(process.argv.slice(2)).catch(() => {
    // Dependency errors can contain terminal text or credentials. Do not log them.
    console.error("Smart Rename native runtime failed");
    process.exitCode = 1;
  });
}
