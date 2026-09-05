import { test } from "bun:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run, snapshot, rename } from "../src/herdr.ts";
import { AutoNameService } from "../src/service.ts";
import { loadState, statePaths } from "../src/storage.ts";

const live =
  process.env.SMART_RENAME_LIVE_TEST === "1" && process.env.HERDR_ENV === "1";
const herdr = process.env.HERDR_BIN_PATH || "herdr";
async function command(...args: string[]) {
  const text = await run(herdr, args);
  return text ? JSON.parse(text) : null;
}

// Same deadline as one Herdr command in the adapter, rather than the model's
// 45-second deadline. A timeout throws through finally so fixtures are closed.
async function waitFor(
  condition: () => Promise<boolean> | boolean,
  expected: string,
) {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out after 10000ms waiting for ${expected}`);
    await Bun.sleep(50);
  }
}

// Opt-in only. These tests create and close their own background tab. No real
// inference or agent process is launched. The worker sees only this test tab.
test.skipIf(!live)(
  "real worker handles pane closure while inference is pending",
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "smart-rename-live-"));
    const paths = statePaths(dir);
    const began = performance.now();
    const timings: Record<string, number> = {};
    let tabId: string | undefined;
    let worker: ReturnType<typeof Bun.spawn> | undefined;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      async fetch() {
        const first = ++requests === 1;
        if (first) await waiting;
        return Response.json({
          id: "fixture",
          object: "chat.completion",
          created: 0,
          model: "fixture",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({
                  tab: first ? "Closed Pane Task" : "Remaining Pane Task",
                  reason: "fixture",
                }),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    try {
      const created = await command(
        "tab",
        "create",
        "--workspace",
        process.env.HERDR_WORKSPACE_ID!,
        "--no-focus",
      );
      tabId = created.result.tab.tab_id;
      const firstPane: string = created.result.root_pane.pane_id;
      const split = await command(
        "pane",
        "split",
        firstPane,
        "--direction",
        "right",
        "--no-focus",
      );
      const secondPane: string = split.result.pane.pane_id;
      for (const pane of [firstPane, secondPane]) {
        await command(
          "pane",
          "report-agent",
          pane,
          "--source",
          "smart-rename-fixture",
          "--agent",
          "pi",
          "--state",
          "idle",
        );
      }
      const wrapper = path.join(dir, "herdr-fixture");
      await writeFile(
        wrapper,
        `#!/usr/bin/env bun
const args = process.argv.slice(2);
const child = Bun.spawn([${JSON.stringify(herdr)}, ...args], { stdout: "pipe", stderr: "pipe", env: process.env });
const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
if (args[0] === "api" && args[1] === "snapshot" && code === 0) {
  const data = JSON.parse(out), snap = data.result.snapshot;
  snap.tabs = snap.tabs.filter(t => t.tab_id === ${JSON.stringify(tabId)});
  snap.panes = snap.panes.filter(p => p.tab_id === ${JSON.stringify(tabId)});
  snap.layouts = snap.layouts.filter(l => l.tab_id === ${JSON.stringify(tabId)});
  snap.workspaces = snap.workspaces.filter(w => snap.tabs.some(t => t.workspace_id === w.workspace_id));
  console.log(JSON.stringify(data));
} else { process.stdout.write(out); process.stderr.write(err); }
process.exitCode = code;
`,
      );
      await chmod(wrapper, 0o700);
      worker = Bun.spawn(
        [process.execPath, path.resolve(import.meta.dir, "../src/worker.ts")],
        {
          env: {
            ...process.env,
            HERDR_BIN_PATH: wrapper,
            HERDR_PLUGIN_STATE_DIR: dir,
            HERDR_PLUGIN_CONFIG_DIR: dir,
            SMART_RENAME_PROVIDER: "fixture",
            SMART_RENAME_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
            SMART_RENAME_MODEL: "fixture",
            SMART_RENAME_API_KEY: "fixture-only",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      await waitFor(() => requests > 0, "worker provider request");
      timings.requestStartedMs = performance.now() - began;
      assert.ok((await loadState(paths.state)).panes[firstPane]);
      await command("pane", "close", firstPane);
      // Event reconciliation must complete BEFORE releasing the model response.
      await waitFor(
        async () => !(await loadState(paths.state)).panes[firstPane],
        "closed-pane state cleanup during inference",
      );
      timings.closedPanePrunedMs = performance.now() - began;
      release();
      await waitFor(
        async () =>
          (await snapshot()).panes.find((p) => p.pane_id === secondPane)
            ?.label === "Remaining Pane Task",
        "surviving pane rename",
      );
      const current = await snapshot();
      assert.equal(
        current.panes.some((p) => p.pane_id === firstPane),
        false,
      );
      assert.notEqual(
        current.tabs.find((t) => t.tab_id === tabId)?.label,
        "Closed Pane Task",
      );
      assert.doesNotMatch(
        await readFile(paths.log, "utf8"),
        /task failed|event failed|rename failed/,
      );
      console.log(
        JSON.stringify({
          liveCase: "close during model",
          closedPane: firstPane,
          survivingPane: secondPane,
          requests,
          timings,
        }),
      );
    } finally {
      release();
      if (worker) {
        worker.kill("SIGTERM");
        await worker.exited;
      }
      server.stop(true);
      if (tabId) await command("tab", "close", tabId);
      await rm(dir, { recursive: true, force: true });
    }
  },
  { timeout: 45_000 },
);

test.skipIf(!live)(
  "real Herdr tab rename preserves manual pane labels and newer manual tab edits",
  async () => {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), "smart-rename-live-scope-"),
    );
    const paths = statePaths(dir);
    let tabId: string | undefined;
    try {
      const created = await command(
        "tab",
        "create",
        "--workspace",
        process.env.HERDR_WORKSPACE_ID!,
        "--no-focus",
      );
      tabId = created.result.tab.tab_id;
      const pane: string = created.result.root_pane.pane_id;
      await rename("pane", pane, "Protected Fixture Pane");
      const service = new AutoNameService({
        stateFile: paths.state,
        stateLock: paths.stateLock,
        namer: {
          suggest: async () => ({
            tab: "Scoped Fixture Rename",
            reason: "fixture",
          }),
        },
      });
      const result = await service.evaluate(tabId!, {
        resetKind: "tab",
        forceModel: true,
      });
      assert.deepEqual(
        result?.changes.map((c) => c.kind),
        ["tab"],
      );
      assert.equal(
        (await snapshot()).panes.find((p) => p.pane_id === pane)?.label,
        "Protected Fixture Pane",
      );
      const delayed = new AutoNameService({
        stateFile: paths.state,
        stateLock: paths.stateLock,
        namer: {
          suggest: async () => {
            await rename("tab", tabId!, "User Chosen Name");
            return { tab: "Outdated Fixture Name", reason: "fixture" };
          },
        },
      });
      const stale = await delayed.evaluate(tabId!, {
        resetKind: "tab",
        forceModel: true,
      });
      assert.deepEqual(stale?.changes, []);
      assert.equal(
        (await snapshot()).tabs.find((t) => t.tab_id === tabId)?.label,
        "User Chosen Name",
      );
      console.log(
        JSON.stringify({
          liveCase: "manual labels and exact action scope",
          tab: tabId,
          pane,
        }),
      );
    } finally {
      if (tabId) await command("tab", "close", tabId);
      await rm(dir, { recursive: true, force: true });
    }
  },
  { timeout: 45_000 },
);

test.skipIf(!live)(
  "real CLI reports provider failures with exit 1 and restores its progress label",
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "smart-rename-live-cli-"));
    let tabId: string | undefined;
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          id: "fixture",
          object: "chat.completion",
          created: 0,
          model: "fixture",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "invalid JSON fixture" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    try {
      const created = await command(
        "tab",
        "create",
        "--workspace",
        process.env.HERDR_WORKSPACE_ID!,
        "--no-focus",
      );
      tabId = created.result.tab.tab_id;
      const pane: string = created.result.root_pane.pane_id;
      const label: string = created.result.tab.label;
      const root = path.resolve(import.meta.dir, "..");
      const child = Bun.spawn(
        [process.execPath, path.join(root, "src/cli.ts"), "rename-now"],
        {
          env: {
            ...process.env,
            HERDR_TAB_ID: tabId!,
            HERDR_PANE_ID: pane,
            HERDR_PLUGIN_ROOT: root,
            HERDR_PLUGIN_STATE_DIR: dir,
            HERDR_PLUGIN_CONFIG_DIR: dir,
            SMART_RENAME_PROVIDER: "fixture",
            SMART_RENAME_API_KEY: "fixture-only",
            SMART_RENAME_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
            SMART_RENAME_MODEL: "fixture",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      assert.equal(exit, 1, stderr);
      const result = JSON.parse(stdout);
      assert.equal(result.outcomes[0].status, "failed");
      assert.match(result.outcomes[0].reason, /AI request failed/);
      assert.equal(
        (await snapshot()).tabs.find((t) => t.tab_id === tabId)?.label,
        label,
      );
    } finally {
      server.stop(true);
      if (tabId) await command("tab", "close", tabId);
      await rm(dir, { recursive: true, force: true });
    }
  },
  { timeout: 45_000 },
);
