import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  acknowledgeRename,
  reconcileItem,
  type NameSuggestion,
} from "../src/domain.ts";
import { type HerdrSnapshot } from "../src/herdr.ts";
import { AutoNameService } from "../src/service.ts";
import { loadState, statePaths } from "../src/storage.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "smart-rename-reliability-"),
  );
  const paths = statePaths(dir);
  const snap: HerdrSnapshot = {
    focused_tab_id: "t1",
    focused_pane_id: "p1",
    workspaces: [{ workspace_id: "w1", label: "Project", number: 1 }],
    tabs: [{ tab_id: "t1", workspace_id: "w1", label: "1", number: 1 }],
    panes: [
      { pane_id: "p1", tab_id: "t1", workspace_id: "w1", agent: "pi" },
      { pane_id: "p2", tab_id: "t1", workspace_id: "w1", agent: "pi" },
    ],
    layouts: [{ tab_id: "t1", focused_pane_id: "p1" }],
  };
  const writes: string[] = [];
  let beforeContext = async () => {};
  let suggest = async (_task: string): Promise<NameSuggestion> => ({
    tab: "Repair Task Naming",
    reason: "current task",
  });
  const service = new AutoNameService({
    stateFile: paths.state,
    stateLock: paths.stateLock,
    namer: {
      suggest: (context) =>
        suggest(
          "userRequests" in context ? context.userRequests[0]! : "unknown",
        ),
    },
    dependencies: {
      snapshot: async () => structuredClone(snap),
      focusedPaneContext: async (pane) => {
        await beforeContext();
        return {
          focused: true,
          label: pane.label ?? "",
          process: null,
          recentOutput: "",
          userMessages: [pane.pane_id],
        };
      },
      siblingPaneContext: async (pane) => ({
        focused: false,
        label: pane.label ?? "",
        process: null,
        recentOutput: "",
        userMessages: [],
      }),
      rename: async (kind, id, label) => {
        writes.push(`${kind}:${id}`);
        const item =
          kind === "tab"
            ? snap.tabs.find((t) => t.tab_id === id)
            : kind === "pane"
              ? snap.panes.find((p) => p.pane_id === id)
              : snap.workspaces.find((w) => w.workspace_id === id);
        if (!item) throw new Error("target closed");
        item.label = label;
      },
    },
  });
  return {
    snap,
    paths,
    service,
    writes,
    setBeforeContext: (next: typeof beforeContext) => {
      beforeContext = next;
    },
    setSuggest: (next: typeof suggest) => {
      suggest = next;
    },
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

test("unchanged pane updates do not acquire manual ownership or consume an expected write", () => {
  const initial = reconcileItem(undefined, "", true);
  assert.equal(acknowledgeRename(initial, "").manual, false);
  const pending = { ...initial, expectedLabel: "Repair Task Naming" };
  assert.deepEqual(acknowledgeRename(pending, ""), pending);
  assert.equal(acknowledgeRename(initial, "My Pane").manual, true);
});

test("explicit tab rename uses manual pane context without renaming any pane", async () => {
  const f = await fixture();
  try {
    f.snap.panes[0]!.label = "My Pane";
    f.snap.panes.splice(1);
    await f.service.initialize();
    const result = await f.service.evaluate("t1", {
      resetKind: "tab",
      forceRefresh: true,
    });
    assert.deepEqual(f.writes, ["tab:t1"]);
    assert.equal(result?.usedModel, true);
    assert.equal(f.snap.panes[0]!.label, "My Pane");
    assert.equal((await loadState(f.paths.state)).panes.p1?.manual, true);
  } finally {
    await f.close();
  }
});

test("reset-pane changes only the target even when siblings and tab are automatic", async () => {
  const f = await fixture();
  try {
    await f.service.initialize();
    await f.service.evaluate("t1", {
      resetKind: "pane",
      targetPaneId: "p2",
      forceRefresh: true,
    });
    assert.deepEqual(f.writes, ["pane:p2"]);
  } finally {
    await f.close();
  }
});

test("one failed pane cannot block a valid tab or another pane", async () => {
  const f = await fixture();
  try {
    f.setSuggest(async (task) => {
      if (task === "p2") throw new Error("provider unavailable");
      return { tab: "Repair Task Naming", reason: "task" };
    });
    await f.service.initialize();
    const result = await f.service.evaluate("t1", { forceRefresh: true });
    assert.deepEqual(f.writes, ["tab:t1", "pane:p1"]);
    assert.ok(
      result?.outcomes?.some((o) => o.id === "p2" && o.status === "failed"),
    );
  } finally {
    await f.close();
  }
});

test("closing a source pane during inference discards its tab and pane suggestions", async () => {
  const f = await fixture();
  try {
    f.setSuggest(async (task) => {
      if (task === "p1")
        f.snap.panes = f.snap.panes.filter((p) => p.pane_id !== "p1");
      return { tab: "Repair Task Naming", reason: "task" };
    });
    await f.service.initialize();
    await f.service.evaluate("t1", { forceRefresh: true });
    assert.equal(f.writes.includes("tab:t1"), false);
    assert.equal(f.writes.includes("pane:p1"), false);
    assert.equal((await loadState(f.paths.state)).panes.p1, undefined);
  } finally {
    await f.close();
  }
});

test("a replacement agent session cannot receive its predecessor's label", async () => {
  const f = await fixture();
  try {
    f.snap.panes[0]!.agent_session = { kind: "path", value: "old.jsonl" };
    f.setSuggest(async () => {
      f.snap.panes[0]!.agent_session = { kind: "path", value: "new.jsonl" };
      return { tab: "Old Session Task", reason: "task" };
    });
    await f.service.initialize();
    await f.service.evaluate("t1", { resetKind: "tab", forceRefresh: true });
    assert.deepEqual(f.writes, []);
  } finally {
    await f.close();
  }
});

test("model latency does not hold the state lock and manual renames still win", async () => {
  const f = await fixture();
  const started = deferred<void>();
  const completion = deferred<NameSuggestion>();
  try {
    f.setSuggest(async () => {
      started.resolve();
      return completion.promise;
    });
    await f.service.initialize();
    const pending = f.service.evaluate("t1", {
      resetKind: "tab",
      forceRefresh: true,
    });
    await started.promise;
    // Acquiring the same state lock while the model is pending must complete.
    f.snap.tabs[0]!.label = "My Manual Tab";
    await f.service.acknowledge("tab", "t1", "My Manual Tab");
    completion.resolve({ tab: "Stale Model Title", reason: "task" });
    await pending;
    assert.deepEqual(f.writes, []);
    assert.equal(f.snap.tabs[0]!.label, "My Manual Tab");
  } finally {
    completion.resolve({ tab: null, reason: "cleanup" });
    await f.close();
  }
});

test("new explicit request supersedes an older pending request", async () => {
  const f = await fixture();
  const started = deferred<void>();
  const first = deferred<NameSuggestion>();
  try {
    let calls = 0;
    f.setSuggest(async () => {
      if (++calls === 1) {
        started.resolve();
        return first.promise;
      }
      return { tab: "New Requested Name", reason: "new task" };
    });
    await f.service.initialize();
    const old = f.service.evaluate("t1", {
      resetKind: "tab",
      forceRefresh: true,
    });
    await started.promise;
    await f.service.evaluate("t1", { resetKind: "tab", forceRefresh: true });
    first.resolve({ tab: "Old Requested Name", reason: "old task" });
    await old;
    assert.equal(f.snap.tabs[0]!.label, "New Requested Name");
    assert.deepEqual(f.writes, ["tab:t1"]);
  } finally {
    first.resolve({ tab: null, reason: "cleanup" });
    await f.close();
  }
});

test("new explicit requests also supersede old context reads, not just model calls", async () => {
  const f = await fixture();
  const started = deferred<void>();
  const contextReady = deferred<void>();
  try {
    let reads = 0;
    f.setBeforeContext(async () => {
      if (++reads === 1) {
        started.resolve();
        await contextReady.promise;
      }
    });
    await f.service.initialize();
    const old = f.service.evaluate("t1", {
      resetKind: "tab",
      forceRefresh: true,
    });
    await started.promise;
    await f.service.evaluate("t1", { resetKind: "tab", forceRefresh: true });
    contextReady.resolve();
    const discarded = await old;
    assert.deepEqual(f.writes, ["tab:t1"]);
    assert.match(discarded!.reason, /superseded/);
  } finally {
    contextReady.resolve();
    await f.close();
  }
});

test("closing the whole tab discards in-flight results and prunes its naming records", async () => {
  const f = await fixture();
  try {
    f.setSuggest(async () => {
      f.snap.tabs = [];
      f.snap.panes = [];
      f.snap.layouts = [];
      return { tab: "Closed Tab Name", reason: "old task" };
    });
    await f.service.initialize();
    await f.service.evaluate("t1", { resetKind: "tab", forceRefresh: true });
    assert.deepEqual(f.writes, []);
    const state = await loadState(f.paths.state);
    for (const map of [
      state.tabs,
      state.panes,
      state.modelAttempts,
      state.fingerprints,
      state.evaluations,
    ]) {
      assert.deepEqual(map, {});
    }
  } finally {
    await f.close();
  }
});

test("delayed old label events cannot lock a newer automatic name", async () => {
  const f = await fixture();
  try {
    await f.service.initialize();
    await f.service.evaluate("t1", { resetKind: "tab", forceRefresh: true });
    await f.service.acknowledge("tab", "t1", "1");
    const record = (await loadState(f.paths.state)).tabs.t1;
    assert.equal(record?.manual, false);
    assert.equal(record?.autoLabel, "Repair Task Naming");
  } finally {
    await f.close();
  }
});

test("resetting a non-agent pane does not rename it or its tab", async () => {
  const f = await fixture();
  try {
    delete f.snap.panes[0]!.agent;
    await f.service.initialize();
    await f.service.evaluate("t1", {
      resetKind: "pane",
      targetPaneId: "p1",
      forceRefresh: true,
    });
    assert.deepEqual(f.writes, []);
  } finally {
    await f.close();
  }
});
