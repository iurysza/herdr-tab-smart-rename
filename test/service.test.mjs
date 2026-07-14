import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AutoNameService,
  focusedPaneFor,
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

test("working agents outrank focused supporting commands", () => {
  const snap = liveSnapshot();
  snap.layouts[0].focused_pane_id = "server";
  snap.panes[0].agent_status = "working";
  snap.panes.push({
    pane_id: "server",
    tab_id: "t1",
    workspace_id: "w1",
    agent_status: "unknown",
  });
  assert.equal(focusedPaneFor(snap.tabs[0], snap).pane_id, "p1");
});

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

test("all-tab evaluation visits every tab sequentially", async () => {
  const snap = liveSnapshot("1");
  snap.tabs.push({
    tab_id: "t2",
    workspace_id: "w1",
    label: "2",
    number: 2,
  });
  snap.panes.push({
    pane_id: "p2",
    tab_id: "t2",
    workspace_id: "w1",
    cwd: "/tmp/agents",
  });
  snap.layouts.push({ tab_id: "t2", focused_pane_id: "p2" });
  const visits = [];
  const service = new AutoNameService({
    dryRun: true,
    namer: { suggest: async () => { throw new Error("unexpected model call"); } },
    dependencies: {
      snapshot: async () => snap,
      focusedPaneContext: async (pane) => {
        visits.push(pane.pane_id);
        return {
          focused: true,
          process: { name: "node", command: "node --test", cwd: pane.cwd },
          recentOutput: "",
          userMessages: [],
        };
      },
      siblingPaneContext: async () => ({ focused: false }),
      rename: async () => { throw new Error("unexpected rename"); },
    },
  });

  const results = await service.evaluateAll(snap);
  assert.deepEqual(visits, ["p1", "p2"]);
  assert.deepEqual(results.map((result) => result.tab), ["t1", "t2"]);
  assert.deepEqual(
    results.map((result) => result.candidate.tab),
    ["Run Tests", "Run Tests"],
  );
});

test("weak command context waits for stability before model abstention", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autoname-stable-"));
  const paths = statePaths(dir);
  const snap = liveSnapshot("1");
  delete snap.panes[0].agent;
  let modelCalls = 0;
  let renames = 0;
  const service = new AutoNameService({
    stateFile: paths.state,
    stateLock: paths.stateLock,
    namer: {
      suggest: async () => {
        modelCalls += 1;
        return { tab: null, reason: "no meaningful task" };
      },
    },
    dependencies: {
      snapshot: async () => snap,
      focusedPaneContext: async () => ({
        focused: true,
        process: { name: "zsh", command: "zsh", cwd: "/tmp/agents" },
        recentOutput: "",
        userMessages: [],
      }),
      siblingPaneContext: async () => ({ focused: false }),
      rename: async () => { renames += 1; },
    },
  });
  try {
    await service.initialize(snap);
    const first = await service.evaluate("t1", { snapshot: snap });
    assert.equal(first.reason, "waiting for stable command context");
    assert.equal(modelCalls, 0);
    const second = await service.evaluate("t1", { snapshot: snap });
    assert.equal(second.reason, "no meaningful task");
    assert.equal(modelCalls, 1);
    assert.equal(renames, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("forced evaluation bypasses unchanged-context model gating", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autoname-force-"));
  const paths = statePaths(dir);
  const snap = liveSnapshot("1");
  let modelCalls = 0;
  const service = new AutoNameService({
    stateFile: paths.state,
    stateLock: paths.stateLock,
    namer: {
      suggest: async () => {
        modelCalls += 1;
        return { tab: "Forced Rename", reason: "task" };
      },
    },
    dependencies: {
      snapshot: async () => snap,
      focusedPaneContext: async () => ({
        focused: true,
        process: { name: "pi", command: "pi", cwd: "/tmp/agents" },
        recentOutput: "",
        userMessages: ["Force a fresh tab name"],
      }),
      siblingPaneContext: async () => ({ focused: false }),
      rename: async (kind, id, label) => {
        if (kind === "tab" && id === "t1") snap.tabs[0].label = label;
      },
    },
  });
  try {
    await service.initialize(snap);
    await service.evaluate("t1", { snapshot: snap });
    await service.acknowledge("tab", "t1", "Forced Rename");
    const gated = await service.evaluate("t1", { snapshot: snap });
    assert.equal(gated.reason, "unchanged or rate-limited context");
    const forced = await service.evaluate("t1", {
      snapshot: snap,
      forceRefresh: true,
    });
    assert.equal(forced.usedModel, true);
    assert.equal(modelCalls, 2);
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
    namer: { suggest: async () => { modelCalls += 1; throw new Error("unexpected"); } },
    dependencies: {
      snapshot: async () => snap,
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

test("explicit refresh reclaims a manual tab", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autoname-reclaim-"));
  const paths = statePaths(dir);
  const snap = liveSnapshot("Manual Task");
  const service = new AutoNameService({
    stateFile: paths.state,
    stateLock: paths.stateLock,
    namer: {
      suggest: async () => ({ tab: "Fresh Task Name", reason: "current task" }),
    },
    dependencies: {
      snapshot: async () => snap,
      focusedPaneContext: async () => ({
        focused: true,
        process: { name: "pi", command: "pi", cwd: "/tmp/agents" },
        recentOutput: "",
        userMessages: ["Give this tab a fresh task name"],
      }),
      siblingPaneContext: async () => ({ focused: false }),
      rename: async (kind, id, label) => {
        if (kind === "tab" && id === "t1") snap.tabs[0].label = label;
      },
    },
  });
  try {
    await service.initialize(snap);
    const result = await service.evaluate("t1", {
      resetKind: "tab",
      forceRefresh: true,
    });
    assert.equal(result.candidate.tab, "Fresh Task Name");
    assert.equal(result.changes.length, 1);
    assert.equal((await loadState(paths.state)).tabs.t1.manual, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent evaluations reconcile against fresh locked snapshots", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autoname-race-"));
  const paths = statePaths(dir);
  let label = "1";
  const current = () => liveSnapshot(label);
  const service = new AutoNameService({
    stateFile: paths.state,
    stateLock: paths.stateLock,
    namer: { suggest: async () => { throw new Error("unexpected model call"); } },
    dependencies: {
      snapshot: async () => current(),
      focusedPaneContext: async () => ({
        focused: true,
        process: { name: "node", command: "node --test", cwd: "/tmp/agents" },
        recentOutput: "",
        userMessages: [],
      }),
      siblingPaneContext: async () => ({ focused: false }),
      rename: async (kind, id, next) => {
        if (kind === "tab" && id === "t1") label = next;
      },
    },
  });
  try {
    await service.initialize(current());
    await Promise.all([service.evaluate("t1"), service.evaluate("t1")]);
    const record = (await loadState(paths.state)).tabs.t1;
    assert.equal(record.manual, false);
    assert.equal(record.autoLabel, "Run Tests");
    assert.equal(record.expectedLabel, undefined);
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
    namer: { suggest: async () => ({ tab: "Socket Reconnect", reason: "task" }) },
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
    namer: { suggest: async () => { throw new Error("provider unavailable"); } },
    dependencies: {
      snapshot: async () => snap,
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
    namer: { suggest: async () => ({ tab: "Auto Tab Naming", reason: "task" }) },
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
