import { test } from "bun:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createNativeService, HerdrAppClient, type NativeCommand } from "../src/herdr-app.ts";
import { nativeOptions, runNativeOnce, watchNative } from "../src/herdr-app-cli.ts";
import { type Namer } from "../src/provider.ts";
import { type NamingContext } from "../src/domain.ts";

interface FixtureState {
  name: string;
  closed: boolean;
  machine: string | null;
  storedName: string | null;
  read: string;
  writes: number;
  providerCalls: number;
  beforeSuggestion: () => Promise<void>;
  split: boolean;
  focusedPane: string;
}

async function fixture(initialName = "") {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "smart-rename-native-"));
  const calls: string[][] = [];
  const contexts: NamingContext[] = [];

  const facts = {
    address: "t1", state: "live", cwd: "/tmp/project", title: "Working Title",
    created_ms: 100, labels: { "herdr.tab": "tb1", "herdr.space": "sp1" },
    foreground: { name: "python", argv: ["python", "job.py"], cwd: "/tmp/project" },
  };

  const state: FixtureState = {
    name: initialName, closed: false, machine: null,
    storedName: null,
    read: "Review the adapter changes", writes: 0,
    providerCalls: 0,
    beforeSuggestion: async () => {},
    split: false, focusedPane: "p1",
  };

  const command: NativeCommand = async (program, args, input) => {
    calls.push([program, ...args]);
    assert.notEqual(program, "herdr", "native work must not reach the old daemon");

    if (args[0] === "ls") return JSON.stringify({ spaces: [{
      id: "sp1", name: "Project", folder: "/tmp/project", machine: state.machine,
      tabs: state.closed ? [] : [{ id: "tb1", name: state.name || "1", active: true,
        terminals: [{ terminal: "t1", pane: "p1", app: "pi", status: "working" },
          ...state.split ? [{ terminal: "t3", pane: "p3", app: "codex", status: "working" }] : []] },
      { id: "tb2", name: "Unrelated", active: false, terminals: [{ terminal: "t2", pane: "p2", app: null, status: null }] }],
    }] });

    if (args[0] === "status") return JSON.stringify({ tab: "tb1", focused_pane: state.focusedPane });

    if (args[0] === "connect") {
      assert.equal(JSON.parse(input!).method, "doc.get");

      return JSON.stringify({ id: "smart-rename-native", result: { version: 1, value: { spaces: [{
        id: "sp1", tabs: [{ id: "tb1", name: state.storedName ?? state.name }],
      }] } } });
    }

    if (args[0] === "get") {
      assert.ok(["t1", "t3"].includes(args[1]!), "unrelated terminal context must not be read");

      if (args[1] === "t3") return JSON.stringify({ ...facts, address: "t3",
        foreground: { name: "node", argv: ["node", "api.js"], cwd: "/tmp/project" } });

      return JSON.stringify(facts);
    }

    if (args[0] === "read") return JSON.stringify({ text: state.read });

    if (args[0] === "do") {
      assert.equal(args[1], "tab.rename");
      const params = JSON.parse(args[2]!);

      assert.equal(params.id, "tb1");
      state.name = params.name;
      state.writes++;

      return '{"ok":true}';
    }

    throw new Error(`Unexpected command ${program} ${args.join(" ")}`);
  };

  const namer: Namer = { suggest: async (context) => {
    contexts.push(context);
    state.providerCalls++;
    await state.beforeSuggestion();

    return { tab: "Review Native Adapter", reason: "test provider" };
  } };

  const options = { tab: "tb1", stateDir, command, namer, env: { HOME: "/test-home" } };

  return { state, facts, calls, contexts, command, options,
    service: () => createNativeService(options),
    cleanup: () => rm(stateDir, { recursive: true, force: true }) };
}

test("native lookup uses local app IDs and raw names, not old daemon context", async () => {
  const f = await fixture();

  try {
    const snap = await new HerdrAppClient("tb1", {}, f.command).snapshot();

    assert.equal(snap.tabs.length, 1);
    assert.equal(snap.tabs[0]!.label, "");
    assert.equal(snap.tabs[0]!.named, false);
    assert.equal(snap.panes[0]!.terminal_id, "t1");
    assert.match(snap.panes[0]!.agent_session!.value, /^[a-f0-9]{64}$/);
    assert.equal(snap.panes[0]!.agent_session!.value.includes("job.py"), false);
    assert.equal(snap.layouts[0]!.focused_pane_id, "p1");
    assert.equal(snap.focused_tab_id, "tb1");
    assert.equal(f.calls.some((args) => args.includes("t2")), false);
  } finally { await f.cleanup(); }
});

for (const name of ["A Manual Title", "1", "123"]) {
  test(`native naming preserves explicit manual name ${name}`, async () => {
    const f = await fixture(name);
    const service = f.service();

    try {
      const result = await service.evaluate("tb1", { forceModel: true });

      assert.equal(result?.reason, "manual tab ownership");
      assert.equal(f.state.name, name);
      assert.equal(f.state.writes, 0);
      assert.equal(f.state.providerCalls, 0);
    } finally { await service.close(); await f.cleanup(); }
  });
}

test("native naming reuses the service and writes only the selected tab", async () => {
  const f = await fixture();
  const service = f.service();

  try {
    const result = await service.evaluate("tb1");

    assert.equal(result?.usedModel, true, "native Pi context does not wait for unavailable daemon transcripts");
    assert.deepEqual(result?.changes.map((item) => item.kind), ["tab"]);
    assert.equal(f.state.name, "Review Native Adapter");
    assert.equal(f.state.writes, 1);
    await assert.rejects(service.evaluate("tb1", { resetKind: "pane", targetPaneId: "p1" }), /cannot rename pane/);
  } finally { await service.close(); await f.cleanup(); }
});

test("explicit native rename reclaims only its tab", async () => {
  const f = await fixture("Tab Rename Scratch");

  try {
    const result = await runNativeOnce(f.options, true);

    assert.deepEqual(result.changes.map((item) => item.kind), ["tab"]);
    assert.equal(f.state.name, "Review Native Adapter");
  } finally { await f.cleanup(); }
});

for (const change of ["manual", "closed", "program", "session"] as const) {
  test(`native late inference is discarded after ${change} change`, async () => {
    const f = await fixture();
    const service = f.service();

    f.state.beforeSuggestion = async () => {
      if (change === "manual") f.state.name = "New Manual Choice";

      if (change === "closed") f.state.closed = true;

      if (change === "program") f.facts.foreground.argv = ["python", "different.py"];

      if (change === "session") f.facts.created_ms++;
    };

    try {
      const result = await service.evaluate("tb1", { forceModel: true });

      assert.deepEqual(result?.changes, []);
      assert.equal(f.state.writes, 0);

      if (change === "manual") assert.equal(f.state.name, "New Manual Choice");
    } finally { await service.close(); await f.cleanup(); }
  });
}

test("a cleared native name releases manual ownership", async () => {
  const f = await fixture("Manual Choice");
  const service = f.service();

  try {
    await service.evaluate("tb1");
    f.state.name = "";
    const result = await service.evaluate("tb1", { forceModel: true });

    assert.equal(result?.changes[0]?.to, "Review Native Adapter");
  } finally { await service.close(); await f.cleanup(); }
});

test("native provider failure preserves the original label and surfaces failure", async () => {
  const f = await fixture("Tab Rename Scratch");

  try {
    const result = await runNativeOnce({ ...f.options, namer: { suggest: async () => { throw new Error("provider unavailable"); } } }, true);

    assert.equal(result.outcomes?.[0]?.status, "failed");
    assert.equal(f.state.name, "Tab Rename Scratch");
    assert.equal(f.state.writes, 0);
  } finally { await f.cleanup(); }
});

test("native dry run performs neither writes nor state persistence", async () => {
  const f = await fixture();

  try {
    const result = await runNativeOnce({ ...f.options, dryRun: true }, true);

    assert.equal(result.dryRun, true);
    assert.equal(result.changes[0]?.to, "Review Native Adapter");
    assert.equal(f.state.writes, 0);
    await assert.rejects(readFile(path.join(f.options.stateDir, "state.json")), /ENOENT/);
  } finally { await f.cleanup(); }
});

test("native context is bounded and uses existing credential redaction", async () => {
  const f = await fixture();

  f.state.read = `API_KEY=sk-this-is-a-private-token\n${"x".repeat(2_000)}`;

  try {
    const client = new HerdrAppClient("tb1", {}, f.command);
    const snap = await client.snapshot();
    const context = await client.context(snap.panes[0]!, true);

    assert.equal(context.recentOutput.length, 1_000);
    assert.ok(context.recentOutput.includes("[redacted]"));
    assert.equal(context.recentOutput.includes("sk-this"), false);
  } finally { await f.cleanup(); }
});

test("native backend rejects mismatched layout ownership", async () => {
  const f = await fixture("App Name");

  f.state.storedName = "Other Core Name";

  try {
    await assert.rejects(new HerdrAppClient("tb1", {}, f.command).snapshot(), /different core/);
    f.state.storedName = null;
    f.facts.labels["herdr.tab"] = "tb2";
    await assert.rejects(new HerdrAppClient("tb1", {}, f.command).snapshot(), /terminal labels do not match/);
  } finally { await f.cleanup(); }
});

test("native backend rejects remote spaces and unrelated write targets", async () => {
  const f = await fixture();
  const client = new HerdrAppClient("tb1", {}, f.command);

  f.state.machine = "work";

  try {
    await assert.rejects(client.snapshot(), /Remote native spaces/);
    await assert.rejects(client.rename("pane", "p1", "Wrong"), /explicitly selected tab/);
    await assert.rejects(client.rename("tab", "tb2", "Wrong"), /explicitly selected tab/);
    assert.throws(() => new HerdrAppClient("work/tb1"), /local native tab/);
    assert.throws(() => new HerdrAppClient("w1:t1"), /local native tab/);
  } finally { await f.cleanup(); }
});

test("native CLI requires an explicit native target despite inherited daemon IDs", () => {
  const env = { HOME: "/test-home", HERDR_TAB_ID: "w1:t1", HERDR_PLUGIN_STATE_DIR: "/old/state" };

  assert.throws(() => nativeOptions(["rename-now"], env), /usage:/);
  assert.throws(() => nativeOptions(["rename-now", "--tab", "w1:t1"], env), /local native tab/);
  assert.throws(() => nativeOptions(["rename-now", "--tab", "work/tb1"], env), /local native tab/);
  const options = nativeOptions(["once", "--tab", "tb1", "--config-dir", "/chosen/config"], env);

  assert.equal(options.tab, "tb1");
  assert.equal(options.env.HERDR_PLUGIN_CONFIG_DIR, "/chosen/config");
  assert.notEqual(options.stateDir, env.HERDR_PLUGIN_STATE_DIR);
  assert.notEqual(options.stateDir, nativeOptions(["once", "--tab", "tb2"], env).stateDir);
});

async function eventFixture(directory: string) {
  const file = path.join(directory, "fake-hc");

  await writeFile(file, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({channel:null,seq:1,terminals:[]})+"\\n"); setInterval(()=>{},1000);\n`);
  await chmod(file, 0o700);

  return file;
}

// These two lifecycle fixtures use a POSIX shebang executable, not a Windows program.
test.skipIf(process.platform === "win32")("native watcher reevaluates a cleared tab on core events and releases its lock", async () => {
  const f = await fixture("Manual");
  const controller = new AbortController();
  const core = await eventFixture(f.options.stateDir);

  f.state.beforeSuggestion = async () => { controller.abort(); };

  try {
    await watchNative({ ...f.options, env: { HC_BIN_PATH: core }, onReady: () => { f.state.name = ""; } }, controller.signal);
    assert.equal(f.state.name, "Review Native Adapter");
    assert.equal(f.state.writes, 1);
    await assert.rejects(readFile(path.join(f.options.stateDir, "watch.lock")), /ENOENT/);
  } finally { controller.abort(); await f.cleanup(); }
}, { timeout: 10_000 });

test.skipIf(process.platform === "win32")("native watcher rejects a duplicate owner and stops on cancellation", async () => {
  const f = await fixture("Manual");
  const controller = new AbortController();
  const core = await eventFixture(f.options.stateDir);
  const ready = Promise.withResolvers<void>();
  const watching = watchNative({ ...f.options, env: { HC_BIN_PATH: core }, onReady: ready.resolve }, controller.signal);

  try {
    await ready.promise;
    await assert.rejects(watchNative({ ...f.options, env: { HC_BIN_PATH: core } }, controller.signal), /timed out waiting for lock/);
    assert.equal(f.state.writes, 0);
  } finally { controller.abort(); await watching; await f.cleanup(); }
}, { timeout: 10_000 });

test("a split native tab uses the focused agent and only reads its screen", async () => {
  const f = await fixture();
  const service = f.service();

  f.state.split = true;
  f.state.focusedPane = "p3";

  try {
    await service.evaluate("tb1", { forceModel: true });
    const context = f.contexts[0];

    assert.ok(context && "focusedPane" in context);
    assert.equal(context.focusedPane.process?.command, "node api.js");
    assert.equal(f.calls.filter((call) => call[1] === "read").length, 1);
    assert.equal(f.calls.find((call) => call[1] === "read")?.[2], "t3");
  } finally { await service.close(); await f.cleanup(); }
});

test("an unavailable native app fails without falling back to the daemon", async () => {
  const client = new HerdrAppClient("tb1", {}, async () => { throw new Error("native app is not running"); });

  await assert.rejects(client.snapshot(), /native app is not running/);
});
