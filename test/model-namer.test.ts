import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelSourceNamer } from "../src/model-namer.ts";
import { saveModelSelection } from "../src/model-selection.ts";
import type { ModelCompletionRequest, ModelSelection, ModelSource } from "../src/model-source.ts";
import { checkAi } from "../src/cli.ts";

const context = { project: "Plugin", userRequests: ["Repair reconnect"] };
const pi: ModelSelection = { version: 1, source: "pi", provider: "openai-codex", model: "example", profile: "high" };
function source(complete: (request: ModelCompletionRequest) => Promise<string>, close: () => Promise<void> = async () => {}): ModelSource {
  return { id: "pi", listProviders: async () => [], listModels: async () => [], listProfiles: async () => [], validate: async () => {}, complete, close };
}

test("missing model selection keeps the original Direct namer without loading a harness", async () => {
  let directCalls = 0;
  const namer = new ModelSourceNamer({}, async () => { throw new Error("harness must stay lazy"); }, {
    suggest: async (value) => { assert.deepEqual(value, context); directCalls++; return { tab: "Repair Reconnect", reason: "task" }; },
  });
  assert.equal((await namer.suggest(context)).tab, "Repair Reconnect");
  assert.equal(directCalls, 1);
});

test("selected harness receives its model and profile while retaining the reliability parser", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "smart-rename-routing-"));
  let closed = 0;
  const requests: ModelCompletionRequest[] = [];
  const selections: ModelSelection[] = [];
  try {
    await saveModelSelection(directory, pi);
    const namer = new ModelSourceNamer({ HERDR_PLUGIN_CONFIG_DIR: directory }, async (selection) => {
      selections.push(selection);
      return source(async (request) => { requests.push(request); return 'Result:\n```json\n{"tab":"Repair Reconnect","reason":"task"}\n```\nDone'; }, async () => { closed++; });
    });
    assert.equal((await namer.suggest(context)).tab, "Repair Reconnect");
    assert.deepEqual(requests[0]?.selection, pi);
    assert.match(requests[0]?.prompt ?? "", /Repair reconnect/);
    assert.match(requests[0]?.system ?? "", /JSON/);
    await saveModelSelection(directory, { ...pi, model: "other" });
    await namer.suggest(context);
    assert.equal(selections.length, 2);
    assert.equal(closed, 1);
    await namer.close();
    await namer.close();
    assert.equal(closed, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a selected harness failure neither exposes its raw error nor falls back to Direct", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "smart-rename-routing-"));
  try {
    await saveModelSelection(directory, pi);
    const namer = new ModelSourceNamer({ HERDR_PLUGIN_CONFIG_DIR: directory }, async () => source(async () => { throw new Error("private-provider-detail"); }), {
      suggest: async () => { throw new Error("must not fall back"); },
    });
    await assert.rejects(namer.suggest(context), (error: unknown) => {
      assert.match(String(error), /AI pi source failed/);
      assert.doesNotMatch(String(error), /private-provider-detail|must not fall back/);
      return true;
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("switching back to Direct closes the previous harness before reusing existing config", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "smart-rename-routing-"));
  let closed = false;
  try {
    await saveModelSelection(directory, pi);
    const namer = new ModelSourceNamer({ HERDR_PLUGIN_CONFIG_DIR: directory }, async () => source(async () => '{"tab":null,"reason":"no task"}', async () => { closed = true; }), {
      suggest: async () => { assert.equal(closed, true); return { tab: null, reason: "Direct" }; },
    });
    await namer.suggest(context);
    await saveModelSelection(directory, { version: 1, source: "direct", provider: "direct", model: "direct" });
    assert.equal((await namer.suggest(context)).reason, "Direct");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("check-ai validates and closes the selected source without a model request", async () => {
  let closed = false;
  const summary = await checkAi({}, {
    loadSelection: async () => pi,
    loadPrompt: async () => "JSON only",
    sourceFactory: async () => source(async () => { throw new Error("must not complete"); }, async () => { closed = true; }),
    notify: async () => {}, report: () => {},
  });
  assert.match(summary, /pi openai-codex\/example high/);
  assert.equal(closed, true);
});
