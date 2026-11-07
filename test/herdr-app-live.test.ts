import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { run } from "../src/herdr.ts";
import { HerdrAppClient, nativeCommand } from "../src/herdr-app.ts";
import { watchNative } from "../src/herdr-app-cli.ts";

const remoteLive = process.env.SMART_RENAME_NATIVE_REMOTE_LIVE_TEST === "1";

const live = process.env.SMART_RENAME_NATIVE_LIVE_TEST === "1" || remoteLive;

const machine = remoteLive ? process.env.SMART_RENAME_NATIVE_REMOTE_MACHINE : undefined;

const Topology = z.object({ spaces: z.array(z.object({
  id: z.string(), machine: z.string().nullable(), tabs: z.array(z.object({
    id: z.string(), name: z.string(),
    terminals: z.array(z.object({ terminal: z.string(), pane: z.string() })),
  })),
})) });

// Opt-in only: creates and closes one native-app tab; no daemon writes,
// agent launch, real provider request, user config edits or core record deletion.
test.skipIf(!live)(`native ${remoteLive ? "remote " : ""}CLI renames a real app tab and preserves newer manual edits`, async () => {
  if (remoteLive && !machine) throw new Error("SMART_RENAME_NATIVE_REMOTE_MACHINE must explicitly select the approved remote machine");
  const directory = await mkdtemp(path.join(os.tmpdir(), "smart-rename-native-live-"));
  const evidence = process.env.SMART_RENAME_NATIVE_EVIDENCE_DIR ?? directory;

  await mkdir(evidence, { recursive: true });
  const app = process.env.HERDR_APP_BIN_PATH || "herdr-app";
  const core = process.env.HC_BIN_PATH || "hc";

  const original = z.object({ space: z.string(), tab: z.string(), focused_pane: z.string().nullable().optional() })
    .parse(JSON.parse(await run(app, ["status"])));

  const before = Topology.parse(JSON.parse(await run(app, ["ls"])));

  const selectedSpace = machine
    ? before.spaces.find((space) => space.machine === machine)?.id
    : (before.spaces.find((space) => space.id === original.space && space.machine === null)
      ?? before.spaces.find((space) => space.machine === null))?.id;

  assert.ok(selectedSpace, "Approved machine must already have a native-app space");

  if (machine) {
    const inventory = z.object({ machines: z.array(z.object({ name: z.string(), state: z.string(), temporary: z.boolean().optional() })) })
      .parse(JSON.parse(await run(core, ["machine", "ls", "--json"])));

    const selected = inventory.machines.find((entry) => entry.name === machine);

    assert.equal(selected?.state, "connected", "Live test must not establish or replace a remote connection");
    assert.equal(selected?.temporary ?? false, false);
  }

  const names = (topology: z.infer<typeof Topology>, exclude?: string) =>
    topology.spaces.flatMap((space) => space.tabs.flatMap((tab) => tab.id === exclude ? [] : [[tab.id, tab.name]]))
      .sort(([a], [b]) => a!.localeCompare(b!));

  let tab: string | undefined;
  let terminal: string | undefined;
  let mode = "success";
  let requests = 0;
  let watcherReady = false;
  let watcherRenamed = false;
  let watcherSuggestions = 0;
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const records: string[] = [];
  const stopCliChildren: Array<() => Promise<number>> = [];

  const waitForName = async (expected: string) => {
    const ownedTab = tab;

    assert.ok(ownedTab);
    const deadline = performance.now() + 10_000;
    const localId = machine ? ownedTab.slice(machine.length + 1) : ownedTab;

    for (;;) {
      const response = z.object({ result: z.object({ value: z.object({ spaces: z.array(z.object({
        tabs: z.array(z.object({ id: z.string(), name: z.string() })),
      })) }) }) }).parse(JSON.parse(await nativeCommand(process.env)(core, ["connect"], `${JSON.stringify({
        jsonrpc: "2.0", id: "native-live-name-confirmation", method: "doc.get",
        params: machine ? { name: "herdr-app", on: machine } : { name: "herdr-app" },
      })}\n`)));

      const raw = response.result.value.spaces.flatMap((space) => space.tabs).find((item) => item.id === localId)?.name;
      const topology = Topology.parse(JSON.parse(await run(app, ["ls"])));
      const shown = topology.spaces.flatMap((space) => space.tabs).find((item) => item.id === ownedTab);

      if (raw === expected && shown && (expected === "" || shown.name === expected)) return;

      if (performance.now() >= deadline) throw new Error("Owned native name did not settle within 10000ms");
      await Bun.sleep(50);
    }
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      requests++;
      const current = mode;

      if (current === "delayed") {
        requested.resolve();
        await release.promise;
      }

      return Response.json({
        id: "native-fixture", object: "chat.completion", created: 0, model: "fixture",
        choices: [{ index: 0, message: { role: "assistant", content: current === "invalid" ? "not valid JSON" : JSON.stringify({
          tab: current === "delayed" ? "Outdated Native Result" : "Native Library Works",
          reason: "local fixture provider",
        }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });

  const launch = (action: string) => {
    assert.ok(tab);

    const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../src/herdr-app-cli.ts"), action,
      "--tab", tab, "--state-dir", path.join(directory, "state"), "--config-dir", directory], {
      env: {
        ...process.env,
        HERDR_BIN_PATH: "/must-not-call-the-daemon",
        HERDR_TAB_ID: "wNotNative:t1",
        SMART_RENAME_MODEL_SOURCE: "direct",
        SMART_RENAME_PROVIDER: "fixture",
        SMART_RENAME_API_KEY: "fixture-only-not-a-secret",
        SMART_RENAME_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
        SMART_RENAME_MODEL: "fixture",
      },
      stdout: "pipe", stderr: "pipe",
    });

    stopCliChildren.push(async () => {
      if (child.exitCode === null) child.kill();

      return child.exited;
    });

    return Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      .then(([stdout, stderr, exit]) => {
        records.push(JSON.stringify({ action, exit, stdout, stderr }));

        return { stdout, stderr, exit };
      });
  };

  try {
    const created = z.object({ tab: z.string(), terminal: z.string() }).parse(JSON.parse(await run(app, [
      "do", "tab.new", JSON.stringify({ name: "Tab Rename Scratch", space: selectedSpace, folder: machine ? "/tmp" : directory }),
    ])));

    tab = created.tab;
    terminal = created.terminal;

    if (machine) {
      assert.ok(tab.startsWith(`${machine}/`));
      assert.ok(terminal.startsWith(`${machine}/`));
    }

    records.push(JSON.stringify({ created }));
    await run(core, ["send", terminal, "printf 'Native fixture ready\\n'; /bin/cat"]);
    const deadline = performance.now() + 10_000;

    // Shell startup changes foreground identity. Observe our stable fixture before inference.
    for (;;) {
      const facts = z.object({ foreground: z.object({ name: z.string() }).nullable().optional() })
        .parse(JSON.parse(await run(core, ["get", terminal, "--json"])));

      if (facts.foreground?.name === "cat") break;

      if (performance.now() >= deadline) throw new Error("Scratch shell did not reach cat within 10000ms");
    }

    await waitForName("Tab Rename Scratch");
    const initial = await new HerdrAppClient(tab).snapshot();

    assert.equal(initial.tabs[0]?.label, "Tab Rename Scratch");
    await run(app, ["shot", path.join(evidence, "native-live-before.png")]);
    const renamed = await launch("rename-now");

    assert.equal(renamed.exit, 0, renamed.stderr);

    const result = z.object({ usedModel: z.boolean(), changes: z.array(z.object({ kind: z.string(), to: z.string() })) })
      .parse(JSON.parse(renamed.stdout));

    assert.equal(result.usedModel, true);
    assert.deepEqual(result.changes, [{ kind: "tab", to: "Native Library Works" }]);
    const after = Topology.parse(JSON.parse(await run(app, ["ls"])));

    assert.equal(after.spaces.flatMap((space) => space.tabs).find((item) => item.id === tab)?.name, "Native Library Works");
    assert.deepEqual(names(after, tab), names(before));
    await run(app, ["shot", path.join(evidence, "native-live-after.png")]);

    await run(app, ["do", "tab.rename", JSON.stringify({ id: tab, name: "123" })]);
    await waitForName("123");
    const manual = await launch("once");

    assert.equal(manual.exit, 0, manual.stderr);
    assert.deepEqual(JSON.parse(manual.stdout).changes, []);
    assert.equal(requests, 1, "manual numeric titles must not call the provider");

    mode = "delayed";
    const pending = launch("rename-now");

    await Promise.race([requested.promise, pending.then((result) => {
      throw new Error(`Rename exited before the delayed fixture request: ${result.stdout} ${result.stderr}`);
    })]);
    await run(app, ["do", "tab.rename", JSON.stringify({ id: tab, name: "Keep My Manual Title" })]);
    await waitForName("Keep My Manual Title");
    release.resolve();
    const stale = await pending;

    assert.equal(stale.exit, 0, stale.stderr);
    assert.deepEqual(JSON.parse(stale.stdout).changes, []);
    const preserved = Topology.parse(JSON.parse(await run(app, ["ls"])));

    assert.equal(preserved.spaces.flatMap((space) => space.tabs).find((item) => item.id === tab)?.name, "Keep My Manual Title");
    await run(app, ["shot", path.join(evidence, "native-live-manual-preserved.png")]);

    mode = "invalid";
    const failed = await launch("rename-now");

    assert.equal(failed.exit, 1);
    assert.equal(JSON.parse(failed.stdout).outcomes[0].status, "failed");
    assert.deepEqual(JSON.parse(failed.stdout).changes, []);
    assert.equal(requests, 3);

    const controller = new AbortController();
    const watchState = path.join(directory, "watch-state");

    if (machine) {
      const ready = Promise.withResolvers<void>();

      const watching = watchNative({ tab, stateDir: watchState,
        namer: { suggest: async () => {
          watcherSuggestions++;

          return { tab: "Remote Watcher Works", reason: "owned remote fixture only" };
        } },
        onReady: () => { watcherReady = true; ready.resolve(); },
      }, controller.signal);

      try {
        await Promise.race([ready.promise, watching.then(() => { throw new Error("Remote watcher stopped before readiness"); })]);
        await run(app, ["do", "tab.rename", JSON.stringify({ id: tab, name: "" })]);
        await waitForName("");
        const watchDeadline = performance.now() + 10_000;
        let label = "";
        let attempt = 0;

        // Each label change belongs to this scratch terminal and drives a real remote
        // broker event. Space attempts beyond the watcher's existing 400ms debounce
        // so the shared two-observation stability gate can settle without a 60s sweep.
        while (label !== "Remote Watcher Works") {
          if (performance.now() >= watchDeadline) throw new Error("Remote watcher did not rename the owned tab within 10000ms");
          await run(core, ["label", terminal, `smart-rename.fixture=watch-${attempt++}`]);
          await Bun.sleep(500);
          const current = Topology.parse(JSON.parse(await run(app, ["ls"])));

          label = current.spaces.flatMap((space) => space.tabs).find((item) => item.id === tab)?.name ?? "";
        }

        await waitForName("Remote Watcher Works");
        await run(app, ["shot", path.join(evidence, "native-live-watcher.png")]);
        watcherRenamed = true;
      } finally {
        controller.abort();
        await watching;
      }

      assert.equal(watcherSuggestions, 1);
    } else {
      await watchNative({ tab, stateDir: watchState,
        namer: { suggest: async () => { throw new Error("Manual native tab must not request inference"); } },
        onReady: () => { watcherReady = true; controller.abort(); },
      }, controller.signal);
    }

    assert.equal(watcherReady, true);
    const locks: string[] = [];

    for await (const lock of new Bun.Glob("**/watch.lock").scan({ cwd: watchState, dot: true })) locks.push(lock);

    assert.deepEqual(locks, []);
    records.push(JSON.stringify({ nativeWatcher: "ready, cancelled, lock released", watcherReady, watcherRenamed, watcherSuggestions }));
  } finally {
    release.resolve();
    await Promise.all(stopCliChildren.map((stop) => stop()));
    server.stop(true);

    await writeFile(path.join(evidence, "native-live-commands.log"), `${records.join("\n")}\n`);

    if (tab) await run(app, ["do", "tab.close", JSON.stringify({ id: tab, confirmed: true })]);

    // The app acknowledges structural removal before the core finishes killing its shell.
    if (terminal) await run(core, ["wait", terminal, "--timeout", "5", "--json"]);
    await run(app, ["do", "space.select", JSON.stringify({ id: original.space })]);
    await run(app, ["do", "tab.select", JSON.stringify({ id: original.tab })]);

    if (original.focused_pane) await run(app, ["do", "pane.focus", JSON.stringify({ pane: original.focused_pane })]);
    const afterCleanup = Topology.parse(JSON.parse(await run(app, ["ls"])));

    assert.deepEqual(names(afterCleanup), names(before));

    const selected = z.object({ space: z.string(), tab: z.string(), focused_pane: z.string().nullable().optional() })
      .parse(JSON.parse(await run(app, ["status"])));

    assert.equal(selected.space, original.space);
    assert.equal(selected.tab, original.tab);

    if (original.focused_pane) assert.equal(selected.focused_pane, original.focused_pane);
    const finished = terminal ? z.object({ state: z.string() }).parse(JSON.parse(await run(core, ["get", terminal, "--json"]))) : undefined;

    if (finished) assert.equal(finished.state, "finished");

    const proof = { machine: machine ?? null, tab, terminal, requests, watcherRenamed, watcherSuggestions, originalTab: original.tab, restoredTab: selected.tab,
      scratchClosed: true, scratchTerminalState: finished?.state, otherTabNamesUnchanged: true,
      originalPane: original.focused_pane, restoredPane: selected.focused_pane,
      provider: "localhost fixture only", watcherReady, evidence };

    await writeFile(path.join(evidence, "native-live-proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
    await writeFile(path.join(evidence, "native-live-commands.log"), `${records.join("\n")}\n`);
    console.log(JSON.stringify(proof));
  }
}, { timeout: 90_000 });
