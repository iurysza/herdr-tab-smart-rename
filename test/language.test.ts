import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MODEL_RATE_MS } from "../src/domain.ts";
import type { HerdrSnapshot } from "../src/herdr.ts";
import { ModelSourceNamer } from "../src/model-namer.ts";
import { saveModelSelection } from "../src/model-selection.ts";
import { AiSdkNamer } from "../src/provider.ts";
import { AutoNameService } from "../src/service.ts";
import { loadState, statePaths, withStateTransaction } from "../src/storage.ts";

for (const source of ["direct", "pi", "opencode"] as const) {
  test(`${source} discards non-Latin answers without consuming cooldown and accepts accented Latin`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "smart-rename-language-"));
    const paths = statePaths(directory);
    const env = { HERDR_PLUGIN_CONFIG_DIR: directory, SMART_RENAME_API_KEY: "fixture-key" };
    const prompt = "Match the primary language of the user requests.";

    const snap: HerdrSnapshot = {
      workspaces: [{ workspace_id: "w1", label: "Project", number: 1 }],
      tabs: [{ tab_id: "t1", workspace_id: "w1", label: "1", number: 1 }],
      panes: [{ pane_id: "p1", tab_id: "t1", workspace_id: "w1", agent: "pi" }],
      layouts: [{ tab_id: "t1", focused_pane_id: "p1" }],
    };

    let answer = "";
    let completions = 0;
    let task = "Repair authentication";

    const complete = async (request: { system: string }) => {
      assert.equal(request.system, prompt);
      completions++;

      return JSON.stringify({ tab: answer, reason: "task" });
    };

    const namer = new ModelSourceNamer(env, async () => ({
      id: source,
      listProviders: async () => [], listModels: async () => [], listProfiles: async () => [],
      validate: async () => {}, complete,
    }), new AiSdkNamer(env, complete));

    const service = new AutoNameService({
      stateFile: paths.state,
      stateLock: paths.stateLock,
      namer,
      targetKinds: ["tab"],
      dependencies: {
        snapshot: async () => structuredClone(snap),
        focusedPaneContext: async () => ({
          focused: true, label: "", process: null, recentOutput: "", userMessages: [task],
        }),
        rename: async (kind, id, label) => {
          assert.equal(kind, "tab");
          assert.equal(id, "t1");
          snap.tabs[0]!.label = label;
        },
      },
    });

    try {
      await saveModelSelection(directory, { version: 1, source, provider: "openai", model: "fixture" });
      await writeFile(path.join(directory, "naming-prompt.md"), prompt);
      await service.initialize();
      let previousAttempt: number | undefined;

      for (const label of ["修复认证问题", "ログイン 修正", "Исправить Сессию", "Fix Аuth", "Fix Auth认证", "Review A\u093e"]) {
        answer = label;
        const result = await service.evaluate("t1");
        const state = await loadState(paths.state);

        assert.equal(result?.usedModel, true);
        assert.deepEqual(result?.changes, []);
        assert.equal(result?.candidate.tab, null);
        assert.equal(result?.outcomes?.[0]?.status, "skipped");
        assert.match(result?.reason ?? "", /non-Latin/);
        assert.equal(snap.tabs[0]!.label, "1");
        assert.equal(state.modelAttempts.t1, previousAttempt);
        assert.equal(state.retries.t1, undefined);
        assert.equal(state.fingerprints.t1, undefined);
        assert.equal(state.namedSessions.t1, undefined);

        // First prove removal of a fresh attempt, then restoration of an old one.
        const restoredAttempt = previousAttempt ?? Date.now() - MODEL_RATE_MS - 1000;
        previousAttempt = restoredAttempt;
        await withStateTransaction(paths.state, paths.stateLock, (latest) => {
          latest.modelAttempts.t1 = restoredAttempt;
        });
      }

      assert.equal(completions, 6);
      answer = "Café Ação";
      const retried = await service.evaluate("t1");
      assert.equal(retried?.candidate.tab, answer);
      assert.equal(snap.tabs[0]!.label, answer);
      assert.equal(retried?.outcomes?.[0]?.status, "renamed");

      answer = "Configurar Sessa\u0303o";
      const decomposed = await service.evaluate("t1", { forceRefresh: true });
      assert.equal(decomposed?.candidate.tab, answer);
      assert.equal(snap.tabs[0]!.label, answer);
      assert.equal(decomposed?.outcomes?.[0]?.status, "renamed");
      assert.equal(completions, 8);

      task = "Now repair reconnects";
      const cooled = await service.evaluate("t1");
      assert.equal(cooled?.usedModel, false);
      assert.equal(cooled?.reason, "unchanged or rate-limited context");
      assert.equal(completions, 8);
      assert.equal(await readFile(path.join(directory, "naming-prompt.md"), "utf8"), prompt);
    } finally {
      await namer.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
