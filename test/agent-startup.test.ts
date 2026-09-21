import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HerdrSnapshot } from "../src/herdr.ts";
import { AutoNameService } from "../src/service.ts";
import { loadState, statePaths, withStateTransaction } from "../src/storage.ts";

async function fixture(agent = "pi", existing = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "smart-rename-startup-"));
  const paths = statePaths(dir);

  const snap: HerdrSnapshot = {
    workspaces: [{ workspace_id: "w1", label: "Project", number: 1 }],
    tabs: [{ tab_id: "t1", workspace_id: "w1", label: existing ? "Review Auth Changes" : "1", number: 1 }],
    panes: [{ pane_id: "p1", tab_id: "t1", workspace_id: "w1", agent, label: existing ? "Review Auth Changes" : "", cwd: "/tmp/project" }],
    layouts: [{ tab_id: "t1", focused_pane_id: "p1" }],
  };

  let calls = 0;
  let requests: string[] = [];

  const service = new AutoNameService({
    stateFile: paths.state,
    stateLock: paths.stateLock,
    namer: { suggest: async () => {
      calls += 1;

      return { tab: "Review Auth Changes", reason: "user task" };
    } },
    dependencies: {
      snapshot: async () => snap,
      focusedPaneContext: async () => ({
        focused: true,
        label: snap.panes[0]!.label ?? "",
        process: { name: agent, command: agent, cwd: "/tmp/project" },
        recentOutput: "[Skills] browser-tools [Extensions] pi-web-access\nUpdate Available: Run pi update\nPackage Updates Available: pi-web-access",
        userMessages: requests,
      }),
      rename: async (kind, id, label) => {
        if (kind === "tab" && id === "t1") snap.tabs[0]!.label = label;

        if (kind === "pane" && id === "p1") snap.panes[0]!.label = label;
      },
    },
  });

  if (existing) {
    await withStateTransaction(paths.state, paths.stateLock, (state) => {
      for (const [records, id] of [[state.tabs, "t1"], [state.panes, "p1"]] as const)
        records[id] = { autoLabel: "Review Auth Changes", observedLabel: "Review Auth Changes", manual: false };
    });
  }

  await service.initialize(snap);

  return {
    service, snap, paths,
    calls: () => calls,
    request: () => { requests = ["Review the authentication changes"]; },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

for (const agent of ["pi", "claude"]) {
  for (const existing of [false, true]) {
    test(`${agent} startup preserves ${existing ? "automatic" : "default"} labels until a user request`, async () => {
      const f = await fixture(agent, existing);

      try {
        const labels = [f.snap.tabs[0]!.label, f.snap.panes[0]!.label];

        for (let sweep = 0; sweep < 3; sweep++) {
          const result = await f.service.evaluate("t1");

          for (const kind of ["tab", "pane"]) {
            const outcome = result?.outcomes?.find((item) => item.kind === kind);
            assert.equal(outcome?.status, "skipped");
            assert.equal(outcome?.reason, "waiting for the first user request");
          }
        }

        assert.equal(f.calls(), 0);
        assert.deepEqual([f.snap.tabs[0]!.label, f.snap.panes[0]!.label], labels);
        const state = await loadState(f.paths.state);

        for (const id of ["t1", "p1"]) {
          assert.equal(state.modelAttempts[id], undefined);
          assert.equal(state.fingerprints[id], undefined);
        }

        f.request();
        const result = await f.service.evaluate("t1");
        assert.equal(result?.usedModel, true);
        assert.ok(f.calls() > 0);
        assert.equal(f.snap.tabs[0]!.label, "Review Auth Changes");
        assert.equal(f.snap.panes[0]!.label, "Review Auth Changes");
      } finally {
        await f.cleanup();
      }
    });
  }
}

for (const override of ["forceModel", "forceRefresh"] as const) {
  test(`explicit ${override} can name an empty agent session`, async () => {
    const f = await fixture();

    try {
      const result = await f.service.evaluate("t1", { [override]: true });
      assert.equal(result?.usedModel, true);
      assert.ok(f.calls() > 0);
    } finally {
      await f.cleanup();
    }
  });
}

test("agents without transcript support retain terminal-based naming", async () => {
  const f = await fixture("codex");

  try {
    const result = await f.service.evaluate("t1");
    assert.equal(result?.usedModel, true);
    assert.ok(f.calls() > 0);
  } finally {
    await f.cleanup();
  }
});
