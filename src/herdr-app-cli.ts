#!/usr/bin/env bun
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createNativeService, isTransientNativeError, nativeAppHome, parseNativeTarget, type NativeServiceOptions } from "./herdr-app.ts";
import { acquireLock, ensurePrivateDir } from "./storage.ts";
import { sanitizeText } from "./text.ts";

export function nativeOptions(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      tab: { type: "string" },
      "state-dir": { type: "string" },
      "config-dir": { type: "string" },
    },
  });

  const command = positionals[0];
  const tab = values.tab;

  if (!command || positionals.length !== 1 || !["once", "rename-now", "dry-run", "watch"].includes(command) || !tab)
    throw new Error("usage: herdr-app-cli.ts once|rename-now|dry-run|watch --tab <tbN|machine/tbN> [--state-dir PATH] [--config-dir PATH]");

  try {
    parseNativeTarget(tab);
  } catch {
    throw new Error("--tab must name a native tab (tbN or machine/tbN), not a daemon tab");
  }

  const identity = createHash("sha256")
    .update(JSON.stringify([nativeAppHome(env), env.HC_SESSION ?? "default", tab]))
    .digest("hex").slice(0, 16);

  const stateDir = values["state-dir"] ?? path.join(
    env.XDG_STATE_HOME ?? path.join(env.HOME ?? os.homedir(), ".local/state"),
    "herdr-tab-smart-rename", "native", identity,
  );

  const nativeEnv = { ...env };

  if (values["config-dir"]) nativeEnv.HERDR_PLUGIN_CONFIG_DIR = values["config-dir"];

  return { action: command, tab, stateDir, env: nativeEnv, dryRun: command === "dry-run" };
}

export async function runNativeOnce(options: NativeServiceOptions, reclaim = false) {
  const { service } = await createNativeService(options);

  try {
    const result = await service.evaluate(options.tab, reclaim
      ? { resetKind: "tab", forceRefresh: true }
      : {});

    if (!result) throw new Error(`Native tab ${options.tab} is closed or unavailable`);

    return result;
  } finally {
    await service.close();
  }
}

export interface NativeWatchOptions extends NativeServiceOptions {
  onReady?: () => void;
}

export async function watchNative(options: NativeWatchOptions, signal: AbortSignal): Promise<void> {
  // Binding resolves the core-scoped namespace, so the watch lock lives beside its state.
  const { service, stateDir } = await createNativeService(options);

  let release = async () => {};

  let stopEvents = () => {};

  let timer: ReturnType<typeof setTimeout> | undefined;
  let recovery: ReturnType<typeof setInterval> | undefined;
  let pending = false;
  let work = Promise.resolve();

  const evaluate = () => {
    pending = true;
    work = work.then(async () => {
      if (!pending || signal.aborted) return;
      pending = false;
      let result;

      try {
        result = await service.evaluate(options.tab);
      } catch (error) {
        if (!(error instanceof Error) || !isTransientNativeError(error)) throw error;
        // Offline remote: keep state, wait for the next event or recovery sweep.
        console.error(`Smart Rename native watcher: ${sanitizeText(error.message)}`);

        return;
      }

      if (!result) throw new Error(`Native tab ${options.tab} is closed or unavailable`);

      if (result.changes.length || result.outcomes?.some((item) => item.status === "failed"))
        console.log(JSON.stringify(result));
    });
  };

  const stop = () => {
    if (timer) clearTimeout(timer);

    if (recovery) clearInterval(recovery);
    stopEvents();
  };

  const reevaluate = () => {
    evaluate();
    void work.catch((error: Error) => {
      console.error(`Smart Rename native watcher: ${sanitizeText(error.message)}`);
      stop();
    });
  };

  try {
    await ensurePrivateDir(stateDir);
    release = await acquireLock(path.join(stateDir, "watch.lock"), { timeoutMs: 0 });
    await service.initialize().catch((error: Error) => {
      if (!isTransientNativeError(error)) throw error;
    });
    evaluate();
    await work;

    if (signal.aborted) return;
    const env = options.env ?? process.env;

    const child = Bun.spawn([env.HC_BIN_PATH || "hc", "events", "--json"], {
      env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });

    stopEvents = () => { child.kill(); };

    const stderr = new Response(child.stderr).text();
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let ready = false;

    signal.addEventListener("abort", stop, { once: true });
    // Match the existing worker sweep for quiet commands and missed layout changes.
    recovery = setInterval(reevaluate, 60_000);

    for (;;) {
      if (signal.aborted) break;
      const chunk = await reader.read();

      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");

      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!ready && line) {
          JSON.parse(line);
          ready = true;
          console.log(`Smart Rename native watcher ready for ${options.tab}`);
          options.onReady?.();
        }

        // Heartbeats are transport health, not naming evidence.
        if (!line || line.includes('"heartbeat"')) continue;

        if (timer) clearTimeout(timer);
        timer = setTimeout(reevaluate, 400);
      }
    }

    await work;
    const code = await child.exited;
    const error = await stderr;

    if (!signal.aborted)
      throw new Error(`hc events ended unexpectedly with exit ${code}: ${sanitizeText(error)}`);
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
    await work.catch(() => {});
    await service.close();
    await release();
  }
}

export async function nativeMain(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const options = nativeOptions(args, env);

  if (options.action === "watch") {
    const controller = new AbortController();
    const stop = () => controller.abort();

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    try {
      await watchNative(options, controller.signal);
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } else {
    const result = await runNativeOnce(options, options.action === "rename-now");

    console.log(JSON.stringify(result, null, 2));

    if (result.outcomes?.some((item) => item.status === "failed")) process.exitCode = 1;
  }
}

if (import.meta.main) {
  await nativeMain(process.argv.slice(2)).catch((error: Error) => {
    console.error(`Smart Rename native: ${sanitizeText(error.message)}`);
    process.exitCode = 1;
  });
}
