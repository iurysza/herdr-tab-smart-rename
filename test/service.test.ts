import { test } from "bun:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type PaneContext,
  type NameSuggestion,
} from "../src/domain.ts";
import {
  type HerdrPane,
  type HerdrSnapshot,
} from "../src/herdr.ts";
import {
  AutoNameService,
  focusedPaneFor,
  type ServiceDependencies,
} from "../src/service.ts";
import {
  loadState,
  statePaths,
  withStateTransaction,
} from "../src/storage.ts";

function liveSnapshot(tabLabel = "1"): HerdrSnapshot {
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

function contextFor(
  pane: HerdrPane,
  {
    command = "node --test",
    userMessages = [],
  }: { command?: string; userMessages?: string[] } = {},
): PaneContext {
  return {
    focused: true,
    label: pane.label ?? "",
    process: { name: "node", command, cwd: pane.cwd ?? "" },
    recentOutput: "",
    userMessages,
  };
}

function dependencies(
  current: () => HerdrSnapshot,
  overrides: Partial<ServiceDependencies> = {},
): Partial<ServiceDependencies> {
  return {
    snapshot: async () => current(),
    focusedPaneContext: async (pane) => contextFor(pane),
    siblingPaneContext: async (pane) => ({
      ...contextFor(pane),
      focused: false,
      recentOutput: "",
      userMessages: [],
    }),
    rename: async () => {},
    ...overrides,
  };
}

test("working agents outrank focused supporting commands", () => {
  const snap = liveSnapshot();
  snap.layouts[0]!.focused_pane_id = "server";
  snap.panes[0]!.agent_status = "working";
  snap.panes.push({
    pane_id: "server",
    tab_id: "t1",
    workspace_id: "w1",
    agent_status: "unknown",
  });
  assert.equal(focusedPaneFor(snap.tabs[0]!, snap)?.pane_id, "p1");
});

test("state transactions serialize concurrent writers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-state-"));
  const paths = statePaths(dir);
  try {
    await Promise.all(
      Array.from({ length: 20 }, () =>
        withStateTransaction(paths.state, paths.stateLock, (state) => {
          state.count = (typeof state.count === "number" ? state.count : 0) + 1;
        }),
      ),
    );
    assert.equal((await loadState(paths.state)).count, 20);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("all-tab dry run visits tabs sequentially without writing state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-dry-"));
  const paths = statePaths(dir);
  const snap = liveSnapshot();
  snap.tabs.push({ tab_id: "t2", workspace_id: "w1", label: "2", number: 2 });
  snap.panes.push({ pane_id: "p2", tab_id: "t2", workspace_id: "w1" });
  snap.layouts.push({ tab_id: "t2", focused_pane_id: "p2" });
  const visits: string[] = [];
  const service = new AutoNameService({
    stateFile: paths.state,
    stateLock: paths.stateLock,
    dryRun: true,
    namer: { suggest: async () => unexpectedModel() },
    dependencies: dependencies(() => snap, {
      focusedPaneContext: async (pane) => {
        visits.push(pane.pane_id);
        return contextFor(pane);
      },
      rename: async () => {
        throw new Error("unexpected rename");
      },
    }),
  });
  try {
    const results = await service.evaluateAll(snap);
    assert.deepEqual(visits, ["p1", "p2"]);
    assert.deepEqual(results.map((result) => result.candidate.tab), [
      "Run Tests",
      "Run Tests",
    ]);
    await assert.rejects(access(paths.state));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("manual ownership short-circuits context and model work", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-manual-"));
  const paths = statePaths(dir);
  const snap = liveSnapshot("Manual Task");
  const service = new AutoNameService({
    stateFile: paths.state,
    stateLock: paths.stateLock,
    namer: { suggest: async () => unexpectedModel() },
    dependencies: dependencies(() => snap, {
      focusedPaneContext: async () => {
        throw new Error("unexpected context read");
      },
    }),
  });
  try {
    await service.initialize(snap);
    const result = await service.evaluate("t1", { snapshot: snap });
    assert.ok(result);
    assert.equal(result.reason, "manual ownership");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("explicit refresh reclaims manual tabs and bypasses model gates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-force-"));
  const paths = statePaths(dir);
  const snap = liveSnapshot("Manual Task");
  let calls = 0;
  const service = new AutoNameService({
    stateFile: paths.state,
    stateLock: paths.stateLock,
    namer: {
      suggest: async () => {
        calls += 1;
        return { tab: "Fresh Task Name", reason: "current task" };
      },
    },
    dependencies: dependencies(() => snap, {
      focusedPaneContext: async (pane) =>
        contextFor(pane, { userMessages: ["Give this tab a fresh name"] }),
      rename: async (kind, id, label) => {
        if (kind === "tab" && id === "t1") snap.tabs[0]!.label = label;
      },
    }),
  });
  try {
    await service.initialize(snap);
    const first = await service.evaluate("t1", {
      resetKind: "tab",
      forceRefresh: true,
    });
    assert.ok(first);
    await service.acknowledge("tab", "t1", "Fresh Task Name");
    const gated = await service.evaluate("t1");
    assert.ok(gated);
    assert.equal(gated.reason, "unchanged or rate-limited context");
    const forced = await service.evaluate("t1", { forceRefresh: true });
    assert.ok(forced);
    assert.equal(forced.usedModel, true);
    assert.equal(calls, 2);
    assert.equal((await loadState(paths.state)).tabs.t1?.manual, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent evaluations keep expected writes durable and avoid stale races", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-race-"));
  const paths = statePaths(dir);
  let label = "1";
  const current = () => liveSnapshot(label);
  let sawExpected = false;
  const service = new AutoNameService({
    stateFile: paths.state,
    stateLock: paths.stateLock,
    namer: { suggest: async () => unexpectedModel() },
    dependencies: dependencies(current, {
      rename: async (kind, id, next) => {
        if (kind !== "tab" || id !== "t1") return;
        const state = await loadState(paths.state);
        sawExpected ||= state.tabs[id]?.expectedLabel === next;
        label = next;
      },
    }),
  });
  try {
    await service.initialize(current());
    await Promise.all([service.evaluate("t1"), service.evaluate("t1")]);
    const record = (await loadState(paths.state)).tabs.t1;
    assert.equal(sawExpected, true);
    assert.equal(record?.manual, false);
    assert.equal(record?.autoLabel, "Run Tests");
    assert.equal(record?.expectedLabel, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed model calls persist attempt backoff without success fingerprint", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-failure-"));
  const paths = statePaths(dir);
  const snap = liveSnapshot();
  const service = new AutoNameService({
    stateFile: paths.state,
    stateLock: paths.stateLock,
    namer: {
      suggest: async () => {
        throw new Error("provider unavailable");
      },
    },
    dependencies: dependencies(() => snap, {
      focusedPaneContext: async (pane) =>
        contextFor(pane, { userMessages: ["Build automatic tab naming"] }),
    }),
  });
  try {
    await service.initialize(snap);
    await assert.rejects(service.evaluate("t1"), /provider unavailable/);
    const state = await loadState(paths.state);
    assert.equal(typeof state.modelAttempts.t1, "number");
    assert.equal(state.fingerprints.t1, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function unexpectedModel(): NameSuggestion {
  throw new Error("unexpected model call");
}
