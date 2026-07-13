import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AutoNameService,
  loadState,
  statePaths,
  withStateTransaction,
} from "../src/service.mjs";

function liveSnapshot(tabLabel = "1") {
  return {
    focused_workspace_id: "w1",
    focused_tab_id: "t1",
    focused_pane_id: "p1",
    workspaces: [
      {
        workspace_id: "w1",
        label: "Agents",
        number: 1,
        active_tab_id: "t1",
      },
    ],
    tabs: [
      {
        tab_id: "t1",
        workspace_id: "w1",
        label: tabLabel,
        number: 1,
      },
    ],
    panes: [
      {
        pane_id: "p1",
        tab_id: "t1",
        workspace_id: "w1",
        cwd: "/tmp/agents",
        agent: "pi",
      },
    ],
    layouts: [{ tab_id: "t1", focused_pane_id: "p1" }],
  };
}

test("state transactions serialize concurrent writers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autoname-state-"));
  const paths = statePaths(dir);
  try {
    await Promise.all(
      Array.from({ length: 20 }, () =>
        withStateTransaction(paths.state, paths.stateLock, async (state) => {
          state.count = (state.count ?? 0) + 1;
        }),
      ),
    );
    assert.equal((await loadState(paths.state)).count, 20);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("manual ownership skips context reads and model calls", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autoname-manual-"));
  const paths = statePaths(dir);
  const snap = liveSnapshot("Manual Task");
  let modelCalls = 0;
  const service = new AutoNameService({
    stateFile: paths.state,
    stateLock: paths.stateLock,
    pi: { suggest: async () => { modelCalls += 1; throw new Error("unexpected"); } },
    dependencies: {
      focusedPaneContext: async () => { throw new Error("unexpected context read"); },
      siblingPaneContext: async () => { throw new Error("unexpected sibling read"); },
      rename: async () => { throw new Error("unexpected rename"); },
    },
  });
  try {
    await service.initialize(snap);
    const result = await service.evaluate("t1", { snapshot: snap });
    assert.equal(result.reason, "manual ownership");
    assert.equal(modelCalls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("expected label is durable before rename and event acknowledgement", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autoname-rename-"));
  const paths = statePaths(dir);
  const snap = liveSnapshot("1");
  let sawExpected = false;
  const service = new AutoNameService({
    stateFile: paths.state,
    stateLock: paths.stateLock,
    pi: { suggest: async () => ({ tab: "Socket Reconnect", reason: "task" }) },
    dependencies: {
      snapshot: async () => snap,
      focusedPaneContext: async () => ({
        focused: true,
        process: { name: "pi", command: "pi", cwd: "/tmp/agents" },
        recentOutput: "",
        userMessages: ["Fix socket reconnect"],
      }),
      siblingPaneContext: async () => ({ focused: false }),
      rename: async (kind, id, label) => {
        if (kind !== "tab") return;
        const state = JSON.parse(await readFile(paths.state, "utf8"));
        sawExpected = state.tabs[id].expectedLabel === label;
      },
    },
  });
  try {
    await service.initialize(snap);
    await service.evaluate("t1", { snapshot: snap });
    assert.equal(sawExpected, true);
    await service.acknowledge("tab", "t1", "Socket Reconnect");
    const state = await loadState(paths.state);
    assert.equal(state.tabs.t1.autoLabel, "Socket Reconnect");
    assert.equal(state.tabs.t1.manual, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed model calls persist attempt backoff only", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autoname-failure-"));
  const paths = statePaths(dir);
  const snap = liveSnapshot("1");
  const service = new AutoNameService({
    stateFile: paths.state,
    stateLock: paths.stateLock,
    pi: { suggest: async () => { throw new Error("provider unavailable"); } },
    dependencies: {
      focusedPaneContext: async () => ({
        focused: true,
        process: { name: "pi", command: "pi", cwd: "/tmp/agents" },
        recentOutput: "",
        userMessages: ["Build automatic tab naming"],
      }),
      siblingPaneContext: async () => ({ focused: false }),
      rename: async () => {},
    },
  });
  try {
    await service.initialize(snap);
    await assert.rejects(
      service.evaluate("t1", { snapshot: snap }),
      /provider unavailable/,
    );
    const state = await loadState(paths.state);
    assert.equal(typeof state.modelAttempts.t1, "number");
    assert.equal(state.fingerprints.t1, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dry-run does not create state or call rename", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autoname-dry-"));
  const paths = statePaths(dir);
  const snap = liveSnapshot("1");
  let renames = 0;
  const service = new AutoNameService({
    stateFile: paths.state,
    stateLock: paths.stateLock,
    dryRun: true,
    pi: { suggest: async () => ({ tab: "Auto Tab Naming", reason: "task" }) },
    dependencies: {
      focusedPaneContext: async () => ({
        focused: true,
        process: { name: "pi", command: "pi", cwd: "/tmp/agents" },
        recentOutput: "",
        userMessages: ["Build automatic tab naming"],
      }),
      siblingPaneContext: async () => ({ focused: false }),
      rename: async () => { renames += 1; },
    },
  });
  try {
    const result = await service.evaluate("t1", { snapshot: snap });
    assert.equal(result.dryRun, true);
    assert.equal(result.candidate.tab, "Auto Tab Naming");
    assert.equal(renames, 0);
    await assert.rejects(access(paths.state));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
