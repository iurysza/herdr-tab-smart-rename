import { test } from "bun:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createNativeService, HerdrAppClient, NativeTargetError, type NativeCommand } from "../src/herdr-app.ts";
import { nativeOptions, runNativeOnce, watchNative } from "../src/herdr-app-cli.ts";
import { gitRoot } from "../src/herdr.ts";
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
  // Remote core as reported by `hc machine ls`.
  core: string;
  session: string;
  machineState: string;
  docError: string | null;
  // Document reads after a write before the new name persists; -1 never persists.
  persistLag: number;
  afterWrite: () => void;
  // App hides a disconnecting remote's spaces while its document survives.
  appHidden: boolean;
}

// `remote` qualifies app IDs with that machine; core facts keep bare labels.
async function fixture(initialName = "", remote: string | null = null) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "smart-rename-native-"));
  const calls: string[][] = [];
  const contexts: NamingContext[] = [];
  const docTargets: (string | undefined)[] = [];
  const q = (id: string) => remote ? `${remote}/${id}` : id;

  const facts = {
    address: q("t1"), state: "live", cwd: "/tmp/project", title: "Working Title",
    created_ms: 100, labels: { "herdr.tab": "tb1", "herdr.space": "sp1" },
    foreground: { name: "python", argv: ["python", "job.py"], cwd: "/tmp/project" },
  };

  const state: FixtureState = {
    name: initialName, closed: false, machine: remote,
    storedName: null,
    read: "Review the adapter changes", writes: 0,
    providerCalls: 0,
    beforeSuggestion: async () => {},
    split: false, focusedPane: q("p1"),
    core: "core-a", session: "session-a", machineState: "connected", docError: null,
    persistLag: 0, afterWrite: () => {}, appHidden: false,
  };

  const command: NativeCommand = async (program, args, input) => {
    calls.push([program, ...args]);
    assert.notEqual(program, "herdr", "native work must not reach the old daemon");
    assert.notEqual(program, "git", "native work must not run local git");

    if (args[0] === "ls") return JSON.stringify({ spaces: state.appHidden ? [] : [{
      id: q("sp1"), name: "Project", folder: "/tmp/project", machine: state.machine,
      tabs: state.closed ? [] : [{ id: q("tb1"), name: state.name || "1", active: true,
        terminals: [{ terminal: q("t1"), pane: q("p1"), app: "pi", status: "working" },
          ...state.split ? [{ terminal: q("t3"), pane: q("p3"), app: "codex", status: "working" }] : []] },
      { id: q("tb2"), name: "Unrelated", active: false, terminals: [{ terminal: q("t2"), pane: q("p2"), app: null, status: null }] }],
    }] });

    if (args[0] === "status") return JSON.stringify({ tab: q("tb1"), focused_pane: state.focusedPane });

    if (args[0] === "machine") {
      assert.ok(remote, "local targets must not consult remote machines");

      return JSON.stringify({ machines: [
        { name: "elsewhere", id: "core-z", state: "connected", session: "s" },
        { name: remote, id: state.core, state: state.machineState, session: state.session },
      ] });
    }

    if (args[0] === "connect") {
      const request = JSON.parse(input!);

      assert.equal(request.method, "doc.get");
      docTargets.push(request.params.on);

      if (state.docError || (remote && state.machineState !== "connected"))
        return JSON.stringify({ id: "smart-rename-native", error: { message: "remote unavailable",
          data: { kind: state.docError ?? "unavailable" } } });

      if (state.persistLag > 0 && --state.persistLag === 0) state.storedName = null;

      // Remote documents use bare IDs.
      return JSON.stringify({ id: "smart-rename-native", result: { version: 1, value: { spaces: [{
        id: "sp1", tabs: state.closed ? [] : [{ id: "tb1", name: state.storedName ?? state.name }],
      }] } } });
    }

    if (args[0] === "get") {
      assert.ok([q("t1"), q("t3")].includes(args[1]!), "unrelated terminal context must not be read");

      if (args[1] === q("t3")) return JSON.stringify({ ...facts, address: q("t3"),
        foreground: { name: "node", argv: ["node", "api.js"], cwd: "/tmp/project" } });

      return JSON.stringify(facts);
    }

    if (args[0] === "read") return JSON.stringify({ text: state.read });

    if (args[0] === "do") {
      assert.equal(args[1], "tab.rename");
      const params = JSON.parse(args[2]!);

      assert.equal(params.id, q("tb1"));

      if (state.persistLag !== 0) state.storedName = state.name;
      state.name = params.name;
      state.writes++;
      state.afterWrite();

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

  const options = { tab: q("tb1"), stateDir, command, namer, env: { HOME: "/test-home" } };

  return { state, facts, calls, contexts, docTargets, command, options, q,
    service: async () => (await createNativeService(options)).service,
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
    const service = await f.service();

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
  const service = await f.service();

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
    const service = await f.service();

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
  const service = await f.service();

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

test("native backend rejects unrelated write targets and daemon IDs", async () => {
  const f = await fixture();
  const client = new HerdrAppClient("tb1", {}, f.command);

  try {
    await assert.rejects(client.rename("pane", "p1", "Wrong"), /explicitly selected tab/);
    await assert.rejects(client.rename("tab", "tb2", "Wrong"), /explicitly selected tab/);
    assert.throws(() => new HerdrAppClient("w1:t1"), /native tab ID/);
    assert.throws(() => new HerdrAppClient("local/tb1"), /native tab ID/);
    assert.throws(() => new HerdrAppClient("a/b/tb1"), /native tab ID/);
  } finally { await f.cleanup(); }
});

test("native CLI requires an explicit native target despite inherited daemon IDs", () => {
  const env = { HOME: "/test-home", HERDR_TAB_ID: "w1:t1", HERDR_PLUGIN_STATE_DIR: "/old/state" };

  assert.throws(() => nativeOptions(["rename-now"], env), /usage:/);
  assert.throws(() => nativeOptions(["rename-now", "--tab", "w1:t1"], env), /not a daemon tab/);
  const options = nativeOptions(["once", "--tab", "tb1", "--config-dir", "/chosen/config"], env);

  assert.equal(options.tab, "tb1");
  assert.equal(options.env.HERDR_PLUGIN_CONFIG_DIR, "/chosen/config");
  assert.notEqual(options.stateDir, env.HERDR_PLUGIN_STATE_DIR);
  assert.notEqual(options.stateDir, nativeOptions(["once", "--tab", "tb2"], env).stateDir);
  assert.equal(nativeOptions(["once", "--tab", "work/tb1"], env).tab, "work/tb1");
  assert.notEqual(nativeOptions(["once", "--tab", "work/tb1"], env).stateDir, options.stateDir);
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
  const service = await f.service();

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

const stored = async (stateDir: string) => JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8"));

test("remote naming routes qualified IDs and compares bare document and label IDs", async () => {
  const f = await fixture("", "work");
  const { service, stateDir } = await createNativeService(f.options);

  try {
    const result = await service.evaluate("work/tb1");

    assert.deepEqual(result?.changes.map((item) => item.to), ["Review Native Adapter"]);
    assert.equal(f.state.writes, 1);
    assert.ok(f.docTargets.length > 0 && f.docTargets.every((on) => on === "work"), "doc.get targets the tab's machine");
    assert.ok(f.calls.some((call) => call[1] === "get" && call[2] === "work/t1"));
    assert.ok(f.calls.some((call) => call[1] === "do" && JSON.parse(call[3]!).id === "work/tb1"));
    assert.ok(stateDir.startsWith(path.join(f.options.stateDir, "remote")));
    const saved = JSON.stringify(await stored(stateDir));

    assert.ok(saved.includes("work/tb1"));
    assert.equal(saved.includes("job.py"), false, "argv is hashed, never saved raw");
  } finally { await service.close(); await f.cleanup(); }
});

test("identical local and remote tab IDs never cross machines", async () => {
  const local = await fixture();
  const remote = await fixture("", "work");

  try {
    // A local target must not adopt a remote space, even with the same bare tab ID.
    local.state.machine = "work";
    await assert.rejects(new HerdrAppClient("tb1", {}, local.command).snapshot(), /different machine/);
    local.state.machine = "local";
    assert.equal((await new HerdrAppClient("tb1", {}, local.command).snapshot()).tabs.length, 1);
    // The bare local ID is absent from a qualified remote layout: no fallback.
    assert.equal((await new HerdrAppClient("tb1", {}, remote.command).snapshot()).tabs.length, 0);
    remote.state.machine = null;
    await assert.rejects(new HerdrAppClient("work/tb1", {}, remote.command).snapshot(), /different machine/);
    remote.state.machine = "work";
    remote.facts.labels["herdr.tab"] = "work/tb1";
    await assert.rejects(new HerdrAppClient("work/tb1", {}, remote.command).snapshot(), /labels do not match/);

    const base = local.options.stateDir;
    const localDir = (await createNativeService({ ...local.options, stateDir: base })).stateDir;
    const remoteDir = (await createNativeService({ ...remote.options, stateDir: base })).stateDir;

    assert.equal(localDir, base);
    assert.notEqual(remoteDir, localDir);
  } finally { await local.cleanup(); await remote.cleanup(); }
});

test("remote state is scoped by permanent core, session and machine, not alias", async () => {
  const work = await fixture("", "work");
  const other = await fixture("", "other");
  const base = work.options.stateDir;
  const dir = async (f: typeof work) => (await createNativeService({ ...f.options, stateDir: base })).stateDir;

  try {
    const first = await createNativeService(work.options);

    await first.service.evaluate("work/tb1");
    await first.service.close();
    assert.equal((await stored(first.stateDir)).tabs["work/tb1"].expectedLabel, "Review Native Adapter");

    // Same alias now names a different core: fresh namespace, nothing inherited.
    work.state.core = "core-b";
    const moved = await dir(work);

    assert.notEqual(moved, first.stateDir);
    await assert.rejects(readFile(path.join(moved, "state.json")), /ENOENT/);
    work.state.core = "core-a";
    work.state.session = "session-b";
    assert.notEqual(await dir(work), first.stateDir);
    work.state.session = "session-a";
    assert.equal(await dir(work), first.stateDir);
    assert.notEqual(await dir(other), first.stateDir);
  } finally { await work.cleanup(); await other.cleanup(); }
});

test("an alias remapped to another core is refused before any write", async () => {
  const f = await fixture("", "work");
  const service = await f.service();

  f.state.beforeSuggestion = async () => { f.state.core = "core-b"; };

  try {
    const result = await service.evaluate("work/tb1", { forceModel: true });

    assert.equal(result?.outcomes?.[0]?.status, "failed");
    assert.match(result?.outcomes?.[0]?.reason ?? "", /different core/);
    assert.equal(f.state.writes, 0);
    // A later evaluation stays refused: rebinding needs a restart.
    await assert.rejects(service.evaluate("work/tb1"), (error: Error) => error instanceof NativeTargetError && error.kind === "core_changed");
  } finally { await service.close(); await f.cleanup(); }
});

test("an offline remote preserves manual ownership and never reads as closed", async () => {
  const f = await fixture("Manual Choice", "work");
  const { service, stateDir } = await createNativeService(f.options);

  try {
    assert.equal((await service.evaluate("work/tb1"))?.reason, "manual tab ownership");
    f.state.machineState = "offline";
    await assert.rejects(service.evaluate("work/tb1"), (error: Error) => error instanceof NativeTargetError && error.kind === "unavailable");
    f.state.machineState = "connected";
    f.state.docError = "unavailable";
    await assert.rejects(service.evaluate("work/tb1"), /unavailable/);
    f.state.docError = null;
    assert.equal((await stored(stateDir)).tabs["work/tb1"].manual, true);
    // Disconnecting app spaces vanish before the document does: still not a close.
    f.state.appHidden = true;
    await assert.rejects(service.evaluate("work/tb1"), /does not match/);
    assert.equal((await stored(stateDir)).tabs["work/tb1"].manual, true);
    f.state.appHidden = false;
    assert.equal((await service.evaluate("work/tb1"))?.reason, "manual tab ownership");
    assert.equal(f.state.writes, 0);
    assert.equal(f.state.providerCalls, 0);
  } finally { await service.close(); await f.cleanup(); }
});

test("remote setup distinguishes unavailable machines from permanent failures", async () => {
  const f = await fixture("", "work");

  try {
    f.state.docError = "needs_update";
    await assert.rejects(runNativeOnce(f.options), (error: Error) => error instanceof NativeTargetError && error.kind === "needs_update");
    f.state.docError = "machine_unknown";
    await assert.rejects(runNativeOnce(f.options), (error: Error) => error instanceof NativeTargetError && error.kind === "machine_unknown");
    f.state.docError = null;
    await assert.rejects(runNativeOnce({ ...f.options, tab: "missing/tb1" }), (error: Error) => error instanceof NativeTargetError && error.kind === "machine_unknown");
    f.state.machineState = "offline";
    await assert.rejects(runNativeOnce(f.options), (error: Error) => error instanceof NativeTargetError && error.kind === "unavailable");
    assert.equal(f.state.writes, 0);
  } finally { await f.cleanup(); }
});

test("delayed inference is discarded when the remote disappears", async () => {
  const f = await fixture("", "work");
  const { service, stateDir } = await createNativeService(f.options);

  f.state.beforeSuggestion = async () => { f.state.machineState = "offline"; };

  try {
    const result = await service.evaluate("work/tb1", { forceModel: true });

    assert.equal(result?.outcomes?.[0]?.status, "failed");
    assert.deepEqual(result?.changes, []);
    assert.equal(f.state.writes, 0);
    f.state.machineState = "connected";
    f.state.name = "Later Manual";
    assert.equal((await service.evaluate("work/tb1"))?.reason, "manual tab ownership");
    assert.equal((await stored(stateDir)).tabs["work/tb1"].manual, true);
  } finally { await service.close(); await f.cleanup(); }
});

test("a remote numeric name is manual ownership", async () => {
  const f = await fixture("123", "work");

  try {
    const result = await runNativeOnce(f.options);

    assert.equal(result.reason, "manual tab ownership");
    assert.equal(f.state.writes, 0);
    assert.equal(f.state.providerCalls, 0);
  } finally { await f.cleanup(); }
});

test("a remote rename waits for document persistence and never rewrites", async () => {
  const f = await fixture("", "work");

  f.state.persistLag = 3;

  try {
    const result = await runNativeOnce(f.options);

    assert.equal(result.changes[0]?.to, "Review Native Adapter");
    assert.equal(f.state.writes, 1);
  } finally { await f.cleanup(); }
});

test("a newer manual edit during write confirmation wins without a retry", async () => {
  const f = await fixture("", "work");

  f.state.persistLag = -1;
  f.state.afterWrite = () => { f.state.storedName = "User Edit"; };

  try {
    const result = await runNativeOnce(f.options);

    assert.equal(result.outcomes?.[0]?.status, "failed");
    assert.match(result.outcomes?.[0]?.reason ?? "", /not confirmed/);
    assert.equal(f.state.writes, 1);
  } finally { await f.cleanup(); }
});

test("remote targets never run local git with remote paths", async () => {
  const remote = new HerdrAppClient("work/tb1", {}, async () => { throw new Error("no commands expected"); });
  const local = new HerdrAppClient("tb1", {}, async () => { throw new Error("no commands expected"); });

  // A real local directory: a remote target must still not inspect it locally.
  assert.equal(await remote.dependencies().gitRoot(import.meta.dir), null);
  assert.equal(local.dependencies().gitRoot, gitRoot, "local targets keep the existing git lookup");
});

test.skipIf(process.platform === "win32")("remote watcher shares the once namespace, retries offline and resumes on events", async () => {
  const f = await fixture("", "work");
  const controller = new AbortController();
  const core = await eventFixture(f.options.stateDir);
  // Same env as the watcher, so this resolves the namespace the watcher locks.
  const options = { ...f.options, env: { ...f.options.env, HC_BIN_PATH: core } };
  const { stateDir } = await createNativeService(options);

  // The watcher must bind the known identity even if it starts while disconnected.
  f.state.machineState = "offline";
  f.state.docError = "unavailable";
  f.state.beforeSuggestion = async () => { controller.abort(); };

  try {
    await watchNative({ ...options, onReady: () => {
      assert.equal(f.state.writes, 0);
      f.state.machineState = "connected";
      f.state.docError = null;
    } }, controller.signal);
    assert.equal(f.state.writes, 1);
    assert.equal((await stored(stateDir)).tabs["work/tb1"].expectedLabel, "Review Native Adapter");
    await assert.rejects(readFile(path.join(stateDir, "watch.lock")), /ENOENT/);
  } finally { controller.abort(); await f.cleanup(); }
}, { timeout: 10_000 });

test.skipIf(process.platform === "win32")("remote watcher rejects a duplicate owner and releases its lock on setup failure", async () => {
  const f = await fixture("Manual", "work");
  const controller = new AbortController();
  const core = await eventFixture(f.options.stateDir);
  // Same env as the watcher, so this resolves the namespace the watcher locks.
  const options = { ...f.options, env: { ...f.options.env, HC_BIN_PATH: core } };
  const { stateDir } = await createNativeService(options);
  const ready = Promise.withResolvers<void>();
  const watching = watchNative({ ...options, onReady: ready.resolve }, controller.signal);

  try {
    await ready.promise;
    await assert.rejects(watchNative(options, controller.signal), /timed out waiting for lock/);
    controller.abort();
    await watching;
    await assert.rejects(readFile(path.join(stateDir, "watch.lock")), /ENOENT/);

    f.state.docError = "needs_update";
    await assert.rejects(watchNative(options, new AbortController().signal), /update herdr/);
    await assert.rejects(readFile(path.join(stateDir, "watch.lock")), /ENOENT/);
    assert.equal(f.state.writes, 0);
  } finally { controller.abort(); await watching; await f.cleanup(); }
}, { timeout: 10_000 });

test("core replacement during the pre-write layout read prevents the write", async () => {
  const f = await fixture("", "work");

  const command: NativeCommand = async (program, args, input) => {
    const response = await f.command(program, args, input);

    if (args[0] === "connect") f.state.core = "replacement-core";

    return response;
  };

  const client = new HerdrAppClient("work/tb1", f.options.env, command);

  try {
    await client.bind();
    await assert.rejects(client.rename("tab", "work/tb1", "Must Not Write"),
      (error: Error) => error instanceof NativeTargetError && error.kind === "core_changed");
    assert.equal(f.state.writes, 0);
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform === "win32")("watcher recovers when the remote disconnects during terminal lookup", async () => {
  const f = await fixture("", "work");
  const controller = new AbortController();
  const core = await eventFixture(f.options.stateDir);
  let disconnected = false;
  let ready = false;

  const command: NativeCommand = async (program, args, input) => {
    if (args[0] === "get" && !disconnected) {
      disconnected = true;
      f.state.machineState = "offline";
      throw new Error("remote unavailable during terminal lookup");
    }

    return f.command(program, args, input);
  };

  f.state.beforeSuggestion = async () => { controller.abort(); };

  try {
    await watchNative({ ...f.options, command, env: { ...f.options.env, HC_BIN_PATH: core }, onReady: () => {
      ready = true;
      assert.equal(f.state.writes, 0);
      f.state.machineState = "connected";
    } }, controller.signal);
    assert.equal(ready, true);
    assert.equal(f.state.writes, 1);
  } finally { controller.abort(); await f.cleanup(); }
}, { timeout: 10_000 });

test("terminal lookup failure cannot hide an offline core replacement", async () => {
  const f = await fixture("", "work");

  const command: NativeCommand = async (program, args, input) => {
    if (args[0] === "get") {
      f.state.core = "replacement-core";
      f.state.machineState = "offline";
      throw new Error("terminal unavailable");
    }

    return f.command(program, args, input);
  };

  const client = new HerdrAppClient("work/tb1", f.options.env, command);

  try {
    await assert.rejects(client.snapshot(),
      (error: Error) => error instanceof NativeTargetError && error.kind === "core_changed");
    assert.equal(f.state.writes, 0);
  } finally { await f.cleanup(); }
});
