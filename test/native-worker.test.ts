import { test } from "bun:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nativeOptions, watchNative } from "../src/herdr-app-cli.ts";
import { createNativeService, type NativeCommand } from "../src/herdr-app.ts";
import {
  nativeEvents, nativeWorkerOptions, runNativeWorker,
  type NativeEvents, type NativeWorkerStatus,
} from "../src/native-worker.ts";
import type { Namer } from "../src/provider.ts";
import { MAX_CONCURRENT_TABS } from "../src/service.ts";
import { acquireLock } from "../src/storage.ts";

async function until(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = performance.now() + 6_000;

  for (;;) {
    try { if (await check()) return; } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }

    if (performance.now() > deadline) throw new Error(`Timed out: ${message}`);
    await Bun.sleep(10);
  }
}

interface Tab {
  id: string;
  name: string;
  created: number;
}

async function fixture(ids = ["tb1", "work/tb2"]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-supervisor-"));

  const env = {
    HOME: root, XDG_STATE_HOME: path.join(root, "state"),
    HERDR_APP_HOME: path.join(root, "app"), HC_SESSION: "test-session",
    HERDR_APP_BIN_PATH: "/fake-native-app", HC_BIN_PATH: "/fake-native-core",
  };

  const runtimeDir = path.join(root, "runtime");
  const configDir = path.join(root, "config");
  const tabs = new Map<string, Tab>(ids.map((id) => [id, { id, name: "", created: 1 }]));
  const controller = new AbortController();
  const calls: string[][] = [];
  const writes: string[] = [];
  let appDown = false;
  let coreDown = false;
  let core = "original-core";
  let session = "original-session";
  let machineState = "connected";
  let readFailure = false;
  let closes = 0;
  let suggestions = 0;
  let activeSuggestions = 0;
  let maximumSuggestions = 0;
  let beforeSuggestion = async () => {};

  let streams = 0;
  let maximumStreams = 0;
  let subscriptions = 0;
  let eventSink: ReadableStreamDefaultController<unknown> | undefined;

  const machineOf = (id: string) => id.includes("/") ? id.split("/")[0]! : null;
  const bare = (id: string) => id.split("/").at(-1)!;
  const qualify = (machine: string | null, id: string) => machine ? `${machine}/${id}` : id;

  const command: NativeCommand = async (program, args, input) => {
    calls.push([program, ...args]);
    assert.ok([env.HERDR_APP_BIN_PATH, env.HC_BIN_PATH].includes(program), "only injected app/core commands are allowed");

    if (program === env.HERDR_APP_BIN_PATH && appDown) throw new Error("fake app unavailable SECRET=private-screen");

    if (program === env.HC_BIN_PATH && coreDown) throw new Error("fake core unavailable SECRET=private-screen");

    if (args[0] === "ls") {
      const machines = [...new Set([...tabs.keys()].map(machineOf))];

      return JSON.stringify({ spaces: machines.map((machine) => ({
        id: qualify(machine, "sp1"), name: "Test Project", folder: "", machine,
        tabs: [...tabs.values()].flatMap((tab) => machineOf(tab.id) === machine ? [{
          id: tab.id, name: tab.name || "1", active: true,
          terminals: [{ terminal: qualify(machine, `t${bare(tab.id)}`), pane: qualify(machine, `p${bare(tab.id)}`), app: "pi", status: "working" }],
        }] : []),
      })) });
    }

    if (args[0] === "status") return JSON.stringify({ tab: null, focused_pane: null });

    if (args[0] === "machine") return JSON.stringify({ machines: [{ name: "work", id: core, session, state: machineState }] });

    if (args[0] === "connect") {
      const request = JSON.parse(input!);
      assert.equal(request.method, "doc.get");
      const machine = request.params.on ?? null;

      return JSON.stringify({ id: "smart-rename-native", result: { version: 1, value: { spaces: [{ id: "sp1",
        tabs: [...tabs.values()].flatMap((tab) => machineOf(tab.id) === machine ? [{ id: bare(tab.id), name: tab.name }] : []),
      }] } } });
    }

    if (args[0] === "get" || args[0] === "read") {
      const terminal = args[1]!;
      const id = qualify(machineOf(terminal), bare(terminal).slice(1));
      const tab = tabs.get(id);
      assert.ok(tab, "terminal reads must name a live fixture tab");

      if (args[0] === "read") {
        if (readFailure) throw new Error("fake screen read unavailable");

        return JSON.stringify({ text: `fake task for ${id}` });
      }

      return JSON.stringify({ address: terminal, state: "live", cwd: "", title: "Test Terminal", created_ms: tab.created,
        labels: { "herdr.tab": bare(id), "herdr.space": "sp1" },
        foreground: { name: "python", argv: ["python", "test.py"], cwd: "" },
      });
    }

    if (args[0] === "do") {
      assert.equal(args[1], "tab.rename");
      const value = JSON.parse(args[2]!);
      const tab = tabs.get(value.id);
      assert.ok(tab);
      tab.name = value.name;
      writes.push(value.id);

      return '{"ok":true}';
    }

    throw new Error(`Unexpected fixture command ${args[0]}`);
  };

  const events: NativeEvents = async function* (_env, signal) {
    subscriptions++;
    streams++;
    maximumStreams = Math.max(maximumStreams, streams);
    const stream = new ReadableStream<unknown>({ start(sink) { eventSink = sink; sink.enqueue({ type: "snapshot" }); } });
    const reader = stream.getReader();
    const cancel = () => { void reader.cancel(); };

    signal.addEventListener("abort", cancel, { once: true });

    try {
      if (signal.aborted) cancel();

      for (;;) {
        const chunk = await reader.read();

        if (chunk.done) break;
        yield chunk.value;
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      await reader.cancel();
      reader.releaseLock();
      streams--;
    }
  };

  const namer: Namer = {
    suggest: async () => {
      suggestions++;
      activeSuggestions++;
      maximumSuggestions = Math.max(maximumSuggestions, activeSuggestions);

      try {
        await beforeSuggestion();

        return { tab: "Native Test Task", reason: "contained test source" };
      } finally { activeSuggestions--; }
    },
    close: async () => { closes++; },
  };

  const options = { runtimeDir, configDir, env, command, namer, events };
  const status = async (): Promise<NativeWorkerStatus> => JSON.parse(await readFile(path.join(runtimeDir, "status.json"), "utf8"));

  const allTargetsActive = async () => {
    const health = await status();

    return health.state === "ready" && health.targets.active === tabs.size;
  };

  const emit = () => { assert.ok(eventSink); eventSink.enqueue({ type: "doc.changed" }); };

  const disconnected = () => { assert.ok(eventSink); eventSink.close(); };

  const stateDir = async (id: string) => (await createNativeService({ ...nativeOptions(["watch", "--tab", id], env), command, namer: { suggest: namer.suggest } })).stateDir;

  return {
    root, tabs, controller, calls, writes, options, status, allTargetsActive, emit, disconnected, stateDir,
    get closes() { return closes; }, get suggestions() { return suggestions; },
    get maximumSuggestions() { return maximumSuggestions; }, get subscriptions() { return subscriptions; },
    get maximumStreams() { return maximumStreams; },
    set appDown(value: boolean) { appDown = value; }, set coreDown(value: boolean) { coreDown = value; },
    set core(value: string) { core = value; }, set session(value: string) { session = value; },
    set machineState(value: string) { machineState = value; }, set readFailure(value: boolean) { readFailure = value; },
    set beforeSuggestion(value: () => Promise<void>) { beforeSuggestion = value; },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("service worker flags require absolute config and runtime directories", () => {
  assert.throws(() => nativeWorkerOptions([]), /usage/);
  assert.throws(() => nativeWorkerOptions(["--config-dir", "relative", "--runtime-dir", "/tmp/runtime"]), /usage/);
  assert.throws(() => nativeWorkerOptions(["--config-dir", "/tmp/config", "--runtime-dir", "relative"]), /usage/);
  assert.throws(() => nativeWorkerOptions(["--config-dir", "/tmp/config", "--runtime-dir", "/tmp/runtime", "--tab", "tb1"]));
  assert.deepEqual(nativeWorkerOptions(["--config-dir", "/tmp/config", "--runtime-dir", "/tmp/runtime"], {}), {
    configDir: "/tmp/config", runtimeDir: "/tmp/runtime", env: {},
  });
});

test("one supervisor discovers local, remote and new tabs while preserving manual names", async () => {
  const f = await fixture(["tb1", "work/tb2", "tb3"]);
  f.tabs.get("tb3")!.name = "My Manual Name";
  const worker = runNativeWorker(f.options, f.controller.signal);

  try {
    await until(f.allTargetsActive, "initial discovery");
    assert.deepEqual([...f.writes].sort(), ["tb1", "work/tb2"]);
    assert.equal(f.tabs.get("tb3")!.name, "My Manual Name");
    f.tabs.set("work/tb4", { id: "work/tb4", name: "", created: 1 });
    f.emit();
    await until(() => f.writes.includes("work/tb4"), "new remote tab discovery");
    const health = await f.status();
    assert.equal(health.version, 1);
    assert.equal(health.pid, process.pid);
    assert.equal(health.managedTabs, 4);
    assert.ok(Number.isFinite(Date.parse(health.updatedAt)));
    assert.equal((await stat(path.join(f.options.runtimeDir, "status.json"))).mode & 0o777, 0o600);
    assert.equal(f.subscriptions, 1);
    assert.equal(f.maximumStreams, 1);
    await assert.rejects(readFile(path.join(f.options.runtimeDir, "state.json")), /ENOENT/);
  } finally {
    f.controller.abort(); await worker;
    assert.equal(f.closes, 1);
    assert.equal((await f.status()).state, "stopping");
    assert.equal((await f.status()).managedTabs, 0);
    await f.cleanup();
  }
}, { timeout: 10_000 });

test("closed targets retire without closing the model source used by surviving and future tabs", async () => {
  const f = await fixture();
  f.tabs.get("work/tb2")!.name = "Initially Manual";
  const worker = runNativeWorker(f.options, f.controller.signal);

  try {
    await until(f.allTargetsActive, "initial tabs ready");
    const localState = await f.stateDir("tb1");
    f.tabs.delete("tb1");
    f.emit();
    await until(async () => (await f.status()).managedTabs === 1, "closed target retirement");
    await assert.rejects(readFile(path.join(localState, "watch.lock")), /ENOENT/);
    assert.equal(f.closes, 0, "retiring a service does not own the source");
    f.tabs.get("work/tb2")!.name = "";
    f.tabs.get("work/tb2")!.created++;
    f.tabs.set("tb3", { id: "tb3", name: "", created: 1 });
    f.emit();
    await until(() => f.writes.includes("tb3") && f.writes.filter((id) => id === "work/tb2").length === 1, "surviving and new targets reuse source");
    assert.equal(f.closes, 0);
    assert.equal(f.subscriptions, 1);
  } finally { f.controller.abort(); await worker; assert.equal(f.closes, 1); await f.cleanup(); }
}, { timeout: 10_000 });

test("app/core downtime preserves target locks and resumes without replacement or secret health details", async () => {
  const f = await fixture();
  const worker = runNativeWorker(f.options, f.controller.signal);

  try {
    await until(f.allTargetsActive, "initial tabs ready");
    const localState = await f.stateDir("tb1");
    f.appDown = true;
    f.emit();
    await until(async () => (await f.status()).state === "waiting", "app outage");
    assert.equal((await f.status()).managedTabs, 2);
    await stat(path.join(localState, "watch.lock"));
    assert.equal(JSON.stringify(await f.status()).includes("private-screen"), false);
    f.appDown = false;
    f.coreDown = true;
    f.emit();
    await Bun.sleep(600);
    assert.equal((await f.status()).managedTabs, 2);
    assert.equal((await f.status()).state, "ready");
    assert.equal((await f.status()).targets.waiting, 2);
    f.coreDown = false;
    f.emit();
    await until(f.allTargetsActive, "core recovery");
    assert.equal(f.subscriptions, 1);
    assert.equal(f.closes, 0);
  } finally { f.controller.abort(); await worker; await f.cleanup(); }
}, { timeout: 10_000 });

for (const replacement of ["core", "session"] as const) {
  test(`remote ${replacement} replacement stays blocked while unrelated tabs continue`, async () => {
    const f = await fixture();
    const worker = runNativeWorker(f.options, f.controller.signal);

    try {
      await until(f.allTargetsActive, "initial tabs ready");
      const remoteState = await f.stateDir("work/tb2");
      f.tabs.get("work/tb2")!.name = "";
      f.tabs.get("work/tb2")!.created++;

      if (replacement === "core") f.core = "replacement-core";
      else f.session = "replacement-session";
      f.tabs.set("tb3", { id: "tb3", name: "", created: 1 });
      f.emit();
      await until(() => f.writes.includes("tb3"), "unrelated local target continues");
      await until(async () => (await f.status()).targets.blocked === 1, "replaced target is blocked");
      assert.equal((await f.status()).state, "ready");
      await stat(path.join(remoteState, "watch.lock"));
      f.emit();
      await Bun.sleep(600);
      assert.equal(f.writes.filter((id) => id === "work/tb2").length, 1);
      assert.equal(f.tabs.get("work/tb2")!.name, "");
      assert.equal(f.closes, 0);
    } finally { f.controller.abort(); await worker; await f.cleanup(); }
  }, { timeout: 10_000 });
}

test("scheduler bounds concurrent tab work and deduplicates event bursts", async () => {
  const f = await fixture(["tb1", "tb2", "tb3", "tb4", "work/tb5", "tb6"]);
  const gate = Promise.withResolvers<void>();
  f.beforeSuggestion = () => gate.promise;
  const worker = runNativeWorker(f.options, f.controller.signal);

  try {
    await until(() => f.suggestions === MAX_CONCURRENT_TABS, "bounded first wave");

    for (let index = 0; index < 10; index++) f.emit();
    await Bun.sleep(600);
    assert.equal(f.suggestions, MAX_CONCURRENT_TABS);
    gate.resolve();
    await until(f.allTargetsActive, "queued work drains");
    assert.equal(f.maximumSuggestions, MAX_CONCURRENT_TABS);
    assert.equal(f.suggestions, 6);
    assert.equal(f.writes.length, 6);
    assert.equal(f.subscriptions, 1);
  } finally { gate.resolve(); f.controller.abort(); await worker; await f.cleanup(); }
}, { timeout: 10_000 });

test("supervisor and explicit watch share per-target locks; duplicate supervisor cannot overwrite health", async () => {
  const f = await fixture(["work/tb2"]);
  const worker = runNativeWorker(f.options, f.controller.signal);

  try {
    await until(f.allTargetsActive, "initial target ready");
    const health = await readFile(path.join(f.options.runtimeDir, "status.json"), "utf8");
    await assert.rejects(runNativeWorker(f.options, new AbortController().signal), /timed out waiting for lock/);
    assert.equal(await readFile(path.join(f.options.runtimeDir, "status.json"), "utf8"), health);
    const explicit = { ...nativeOptions(["watch", "--tab", "work/tb2"], f.options.env), command: f.options.command, namer: { suggest: f.options.namer.suggest } };
    await assert.rejects(watchNative(explicit, new AbortController().signal), /timed out waiting for lock/);
  } finally {
    f.controller.abort(); await worker;
    const stateDir = await f.stateDir("work/tb2");
    await assert.rejects(readFile(path.join(stateDir, "watch.lock")), /ENOENT/);
    await assert.rejects(readFile(path.join(f.options.runtimeDir, "supervisor.lock")), /ENOENT/);
    await f.cleanup();
  }
}, { timeout: 10_000 });

test("transport downtime reconnects one unfiltered subscription and discovers tabs after restart", async () => {
  const f = await fixture([]);
  const worker = runNativeWorker(f.options, f.controller.signal);

  try {
    await until(f.allTargetsActive, "empty runtime ready");
    f.disconnected();
    await until(async () => (await f.status()).state === "waiting", "transport loss");
    f.tabs.set("tb1", { id: "tb1", name: "", created: 1 });
    await until(() => f.subscriptions === 2 && f.writes.includes("tb1"), "restart discovers new tab");
    assert.equal(f.subscriptions, 2);
    assert.equal(f.maximumStreams, 1);
    assert.equal(f.closes, 0);
  } finally { f.controller.abort(); await worker; await f.cleanup(); }
}, { timeout: 10_000 });

test("supervised screen-read failures preserve supervision and recover on events", async () => {
  const f = await fixture(["tb1", "work/tb2"]);
  f.readFailure = true;
  const worker = runNativeWorker(f.options, f.controller.signal);

  try {
    await until(async () => (await f.status()).managedTabs === 2 && f.calls.some((call) => call[1] === "read"), "failed screen reads");
    assert.equal(f.writes.length, 0);
    await until(async () => (await f.status()).targets.waiting === 2, "read failures remain per-target");
    assert.equal((await f.status()).state, "ready");
    assert.match((await f.status()).lastError?.reason ?? "", /context read failed/);
    f.readFailure = false;
    f.emit();
    await until(f.allTargetsActive, "screen recovery");
    assert.equal(f.writes.length, 2);
    assert.equal(f.subscriptions, 1);
  } finally { f.controller.abort(); await worker; await f.cleanup(); }
}, { timeout: 10_000 });

test.skipIf(process.platform === "win32")("real event adapter uses only hc events --json and cancels its child", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-event-adapter-"));
  const executable = path.join(root, "fake-hc");
  const receipt = path.join(root, "args.json");
  const controller = new AbortController();
  await writeFile(executable, `#!${process.execPath}\nawait Bun.write(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({type:'snapshot'})); setInterval(()=>{},1000);\n`);
  await chmod(executable, 0o700);

  try {
    for await (const event of nativeEvents({ HOME: root, HC_BIN_PATH: executable }, controller.signal)) {
      assert.deepEqual(event, { type: "snapshot" });
      controller.abort();
    }

    assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")), ["events", "--json"]);
  } finally { controller.abort(); await rm(root, { recursive: true, force: true }); }
}, { timeout: 10_000 });

test("remote binding survives watch-lock contention instead of adopting a replacement", async () => {
  const f = await fixture(["work/tb2"]);
  const originalState = await f.stateDir("work/tb2");
  let release = await acquireLock(path.join(originalState, "watch.lock"), { timeoutMs: 0 });
  const worker = runNativeWorker(f.options, f.controller.signal);

  try {
    await until(() => f.calls.filter((call) => call[1] === "machine").length >= 2, "supervisor binds before contended lock");
    await Bun.sleep(100);
    assert.equal((await f.status()).managedTabs, 0);
    assert.equal(f.writes.length, 0);
    f.core = "replacement-while-contended";
    await release();
    release = async () => {};

    f.emit();
    await until(async () => (await f.status()).managedTabs === 1, "original namespace locked");
    f.emit();
    await Bun.sleep(600);
    assert.equal(f.writes.length, 0);
    assert.equal((await f.status()).state, "ready");
    assert.equal((await f.status()).targets.blocked, 1);
    await stat(path.join(originalState, "watch.lock"));
  } finally { await release(); f.controller.abort(); await worker; await f.cleanup(); }
}, { timeout: 10_000 });

test("startup during app downtime and an offline remote waits and then preserves manual ownership", async () => {
  const f = await fixture();
  f.appDown = true;
  f.machineState = "offline";
  f.tabs.get("work/tb2")!.name = "Remote Manual";
  const worker = runNativeWorker(f.options, f.controller.signal);

  try {
    await until(async () => (await f.status()).state === "waiting", "offline startup health");
    assert.equal(f.writes.length, 0);
    f.appDown = false;
    f.emit();
    await until(() => f.writes.includes("tb1"), "local naming independent of remote outage");
    await until(async () => (await f.status()).managedTabs === 2, "offline remote namespace retained");
    assert.equal(f.tabs.get("work/tb2")!.name, "Remote Manual");
    assert.equal(f.calls.some((call) => call[1] === "read" && call[2]?.startsWith("work/")), false);
    assert.equal((await f.status()).state, "ready");
    assert.equal((await f.status()).targets.waiting, 1);
    f.machineState = "connected";
    f.emit();
    await until(f.allTargetsActive, "remote reconnection");
    assert.equal(f.tabs.get("work/tb2")!.name, "Remote Manual");
    assert.deepEqual(f.writes, ["tb1"]);
  } finally { f.controller.abort(); await worker; await f.cleanup(); }
}, { timeout: 10_000 });

test.skipIf(process.platform === "win32")("source entry publishes health for the exact installed argv and handles SIGTERM", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-worker-entry-"));
  const app = path.join(root, "fake-app");
  const core = path.join(root, "fake-hc");
  const configDir = path.join(root, "config");
  const runtimeDir = path.join(root, "runtime");
  const receipt = path.join(root, "subscription.json");
  await writeFile(app, `#!${process.execPath}\nif(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['ls'])) throw new Error('unexpected fake app command'); console.log(JSON.stringify({spaces:[]}));\n`);
  await writeFile(core, `#!${process.execPath}\nif(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['events','--json'])) throw new Error('unexpected fake core command'); await Bun.write(${JSON.stringify(receipt)}, JSON.stringify({pid:process.pid,argv:process.argv.slice(2)})); console.log(JSON.stringify({type:'snapshot'})); setInterval(()=>{},1000);\n`);
  await chmod(app, 0o700);
  await chmod(core, 0o700);

  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../src/native-worker.ts"),
    "--config-dir", configDir, "--runtime-dir", runtimeDir], {
    env: { HOME: root, HERDR_APP_BIN_PATH: app, HC_BIN_PATH: core, XDG_STATE_HOME: path.join(root, "state") },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });

  const health = async (): Promise<NativeWorkerStatus> => JSON.parse(await readFile(path.join(runtimeDir, "status.json"), "utf8"));

  try {
    await until(async () => (await health()).state === "ready", "entrypoint readiness");
    assert.equal((await health()).pid, child.pid);
    assert.equal((await health()).managedTabs, 0);
    assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")).argv, ["events", "--json"]);
    child.kill("SIGTERM");
    assert.equal(await child.exited, 0);
    assert.equal((await health()).state, "stopping");
    await assert.rejects(readFile(path.join(runtimeDir, "supervisor.lock")), /ENOENT/);
    assert.equal(await new Response(child.stderr).text(), "");
    assert.equal(await new Response(child.stdout).text(), "");
  } finally { child.kill(); await child.exited; await rm(root, { recursive: true, force: true }); }
}, { timeout: 10_000 });

test("runtime cleanup failures publish sanitized failed health and release supervision", async () => {
  const f = await fixture([]);

  const options = { ...f.options, namer: {
    suggest: f.options.namer.suggest,
    close: async () => { throw new Error("fake SECRET=private-source-detail"); },
  } };

  const worker = runNativeWorker(options, f.controller.signal);

  try {
    await until(f.allTargetsActive, "ready before shutdown failure");
    f.controller.abort();
    await assert.rejects(worker, /Cannot close native runtime source/);
    assert.equal((await f.status()).state, "failed");
    assert.equal(JSON.stringify(await f.status()).includes("private-source-detail"), false);
    await assert.rejects(readFile(path.join(f.options.runtimeDir, "supervisor.lock")), /ENOENT/);
  } finally { f.controller.abort(); await worker.catch(() => {}); await f.cleanup(); }
}, { timeout: 10_000 });

test("provider failures do not block readiness and publish only a safe short last error", async () => {
  const f = await fixture(["tb1"]);
  f.beforeSuggestion = async () => {
    throw new Error("AI request failed HTTP 401 Unauthorized API_KEY='private-provider-secret'\nTerminal context: private task text and request body must never be published");
  };

  const worker = runNativeWorker(f.options, f.controller.signal);

  try {
    await until(async () => (await f.status()).lastError?.targetId === "tb1", "provider failure recorded");
    const health = await f.status();
    assert.equal(health.state, "ready");
    // A coalesced follow-up can hit the service's backoff and complete without
    // another failed request. The last error must survive that skipped run.
    assert.equal(health.targets.active + health.targets.waiting, 1);
    assert.equal(health.targets.blocked, 0);
    assert.equal(health.lastError?.reason, "Native request failed (HTTP 401)");
    assert.ok(Number.isFinite(Date.parse(health.lastError?.timestamp ?? "")));
    assert.equal(JSON.stringify(health).includes("private-provider-secret"), false);
    assert.equal(JSON.stringify(health).includes("private task text"), false);
    assert.equal(JSON.stringify(health).includes("request body"), false);
    assert.equal(f.writes.length, 0);
  } finally { f.controller.abort(); await worker; await f.cleanup(); }
}, { timeout: 10_000 });
