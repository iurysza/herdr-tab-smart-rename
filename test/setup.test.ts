import { test } from "bun:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { runSetup, type SetupPrompts } from "../src/setup.ts";
import { renderKeybindingGuidance } from "../src/setup-plan.ts";
import type { ModelSource } from "../src/model-source.ts";

const cancelled = Symbol("cancelled");

const PlaceholderSchema = z.object({ placeholder: z.string() });

const DefaultValueSchema = z.object({ defaultValue: z.string() });

const ReasoningOptionsSchema = z.object({ message: z.literal("Reasoning level"), initialValue: z.string() });

function reasoningOptions(calls: Array<{ kind: string; options: unknown }>) {
  const call = calls.find((item) => item.kind === "select" && ReasoningOptionsSchema.safeParse(item.options).success);

  return ReasoningOptionsSchema.parse(call?.options);
}

function scriptedPrompts(values: Array<string | boolean | symbol>) {
  const nextText = (): string | symbol => z.union([z.string(), z.symbol()]).parse(values.shift());
  const nextConfirm = (): boolean | symbol => z.union([z.boolean(), z.symbol()]).parse(values.shift());
  const calls: Array<{ kind: string; options: unknown }> = [];
  const summaries: string[] = [];

  const prompts: SetupPrompts = {
    select: async (options) => {
      calls.push({ kind: "select", options });

      return nextText();
    },
    autocomplete: async (options) => {
      calls.push({ kind: "autocomplete", options });

      return nextText();
    },
    text: async (options) => {
      calls.push({ kind: "text", options });

      return nextText();
    },
    password: async (options) => {
      calls.push({ kind: "password", options });

      return nextText();
    },
    confirm: async (options) => {
      calls.push({ kind: "confirm", options });

      return nextConfirm();
    },
    spinner: () => ({ start: () => {}, stop: () => {}, error: () => {} }),
    isCancel: (value) => value === cancelled,
    summary: (message) => summaries.push(message),
    cancel: () => {},
    success: () => {},
  };

  return { prompts, calls, summaries };
}

const isolatedSetup = {
  probeExisting: async () => undefined,
  inspectKeybindings: async () => ({ results: [], remoteAttachNote: "remote client" }),
  validate: async () => "validated",
  startWorker: async () => {},
};

function piSource(profiles = ["high"]): ModelSource {
  return {
    id: "pi",
    listProviders: async () => [{ id: "anthropic", label: "Anthropic" }],
    listModels: async () => [{ id: "claude", label: "Claude" }],
    listProfiles: async () => profiles.map((id) => ({ id, label: id })),
    validate: async () => {},
    complete: async () => "",
  };
}

test("keybinding review names runtime state, diagnostics, ownership uncertainty, and remote guidance", () => {
  const guidance = renderKeybindingGuidance({
    path: "/tmp/herdr/config.toml",
    uncertainty: "The configured owner cannot be determined.",
    remoteAttachNote: "Configure the attaching client.",
    results: [
      {
        action: "rename-now",
        status: "already-configured",
        instruction: {
          action: "rename-now",
          label: "Rename the current tab",
          toml: "already-present TOML",
        },
      },
      {
        action: "rename-all",
        status: "colliding",
        diagnostic: "prefix+alt+t is already bound",
        instruction: {
          action: "rename-all",
          label: "Rename all tabs",
          toml: "proposed TOML",
        },
      },
    ],
  });

  assert.match(guidance, /Runtime config path: \/tmp\/herdr\/config\.toml/);
  assert.match(guidance, /already-configured/);
  assert.doesNotMatch(guidance, /already-present TOML/);
  assert.match(guidance, /Diagnostic: prefix\+alt\+t is already bound/);
  assert.match(guidance, /Proposed TOML for rename-all:\nproposed TOML/);
  assert.match(guidance, /Ownership uncertainty/);
  assert.match(guidance, /Remote attach: Configure the attaching client/);
});

test("wizard discovers and searches each selected Pi stage before persisting", async () => {
  const ui = scriptedPrompts(["pi", "anthropic", "claude", "high", false, false, true]);
  const saved: unknown[] = [];
  const calls: string[] = [];

  const source: ModelSource = {
    ...piSource(),
    listProviders: async () => {
      calls.push("providers");

      return [{ id: "anthropic", label: "Anthropic" }];
    },
    listModels: async (provider) => {
      calls.push(`models:${provider}`);

      return [{ id: "claude", label: "Claude" }];
    },
    listProfiles: async (provider, model) => {
      calls.push(`profiles:${provider}/${model}`);

      return [{ id: "high", label: "High" }];
    },
  };

  const result = await runSetup(
    {},
    {
      ...isolatedSetup,
      prompts: ui.prompts,
      resolveConfigDirectory: async () => "/config",
      sourceFactory: async () => source,
      saveSelection: async (_directory, selection) => {
        saved.push(selection);
      },
    },
  );

  assert.deepEqual(calls, ["providers", "models:anthropic", "profiles:anthropic/claude"]);
  assert.equal(
    ui.calls.filter((call) => call.kind === "autocomplete").length,
    3,
  );
  assert.equal(
    PlaceholderSchema.parse(ui.calls.find((call) => call.kind === "autocomplete")?.options).placeholder,
    "Search providers",
  );
  assert.deepEqual(result, {
    saved: true,
    selection: {
      version: 1,
      source: "pi",
      provider: "anthropic",
      model: "claude",
      profile: "high",
    },
  });
  assert.deepEqual(saved, [result.selection]);
});

test("wizard skips an unsupported profile and cancellation makes no write", async () => {
  const ui = scriptedPrompts(["pi", "anthropic", "claude", false, false, true]);
  let writes = 0;
  await runSetup(
    {},
    {
      ...isolatedSetup,
      prompts: ui.prompts,
      resolveConfigDirectory: async () => "/config",
      sourceFactory: async () => piSource([]),
      saveSelection: async () => {
        writes += 1;
      },
    },
  );
  assert.equal(ui.calls.filter((call) => call.kind === "autocomplete").length, 2);
  assert.equal(writes, 1);

  const cancelledUi = scriptedPrompts([cancelled]);

  const result = await runSetup(
    {},
    {
      ...isolatedSetup,
      prompts: cancelledUi.prompts,
      resolveConfigDirectory: async () => "/config",
      saveSelection: async () => {
        writes += 1;
      },
    },
  );

  assert.deepEqual(result, { saved: false });
  assert.equal(writes, 1);
});

test("cancelling any Direct or kept-configuration setup prompt changes neither config nor worker", async () => {
  const directAnswers = [
    "direct",
    "openai",
    "https://api.example/v1",
    "gpt-test",
    "direct-secret",
    "low",
    "12000",
    false,
    false,
    true,
  ];

  for (const index of directAnswers.keys()) {
    const answers = directAnswers.map((value, answerIndex) => answerIndex === index ? cancelled : value);
    const ui = scriptedPrompts(answers);
    let writes = 0;
    let starts = 0;

    const result = await runSetup({}, {
      ...isolatedSetup,
      prompts: ui.prompts,
      resolveConfigDirectory: async () => "/config",
      saveDirect: async () => { writes += 1; },
      saveSelection: async () => { writes += 1; },
      startWorker: async () => { starts += 1; },
    });

    assert.deepEqual(result, { saved: false });
    assert.equal(writes, 0);
    assert.equal(starts, 0);
  }

  const existing = { version: 1 as const, source: "pi" as const, provider: "anthropic", model: "claude" };

  for (const index of [0, 1, 2, 3]) {
    const answers = [true, false, false, true].map((value, answerIndex) => answerIndex === index ? cancelled : value);
    const ui = scriptedPrompts(answers);
    let writes = 0;
    let starts = 0;

    const result = await runSetup({}, {
      ...isolatedSetup,
      prompts: ui.prompts,
      resolveConfigDirectory: async () => "/config",
      probeExisting: async () => existing,
      saveSelection: async () => { writes += 1; },
      startWorker: async () => { starts += 1; },
    });

    assert.deepEqual(result, { saved: false });
    assert.equal(writes, 0);
    assert.equal(starts, 0);
  }
});

test("Direct wizard masks the API key and persists private connection mapping", async () => {
  const key = "direct-secret";

  const ui = scriptedPrompts([
    "direct",
    "openai",
    "https://api.example/v1",
    "gpt-test",
    key,
    "low",
    "12000",
    false,
    false,
    true,
  ]);

  const writes: Array<{ kind: string; value: unknown }> = [];

  const result = await runSetup(
    {},
    {
      ...isolatedSetup,
      prompts: ui.prompts,
      resolveConfigDirectory: async () => "/config",
      saveDirect: async (config) => {
        writes.push({ kind: "direct", value: config });
      },
      saveSelection: async (_directory, selection) => {
        writes.push({ kind: "selection", value: selection });
      },
    },
  );

  assert.equal(ui.calls.filter((call) => call.kind === "password").length, 1);
  const textCalls = ui.calls.filter((call) => call.kind === "text");
  assert.equal(
    DefaultValueSchema.parse(textCalls[0]?.options).defaultValue,
    "openai",
  );
  assert.equal(
    DefaultValueSchema.parse(textCalls[1]?.options).defaultValue,
    "https://api.openai.com/v1",
  );
  assert.equal(
    DefaultValueSchema.parse(textCalls[2]?.options).defaultValue,
    "gpt-5.6-luna",
  );
  assert.equal(
    reasoningOptions(ui.calls).initialValue,
    "medium",
  );
  assert.deepEqual(writes, [
    {
      kind: "direct",
      value: {
        provider: "openai",
        baseURL: "https://api.example/v1",
        model: "gpt-test",
        apiKey: key,
        reasoningEffort: "low",
        timeoutMs: 12_000,
      },
    },
    {
      kind: "selection",
      value: {
        version: 1,
        source: "direct",
        provider: "openai",
        model: "gpt-test",
        profile: "low",
      },
    },
  ]);
  assert.ok(ui.summaries.every((summary) => !summary.includes(key)));
  assert.equal(result.saved, true);
});

test("Direct wizard derives DeepSeek suggestions from its provider profile", async () => {
  const ui = scriptedPrompts([
    "direct",
    "deepseek",
    "https://api.deepseek.com",
    "deepseek-flash",
    "deepseek-secret",
    "none",
    "45000",
    false,
    false,
    true,
  ]);

  await runSetup(
    {},
    {
      ...isolatedSetup,
      prompts: ui.prompts,
      resolveConfigDirectory: async () => "/config",
      saveDirect: async () => {},
      saveSelection: async () => {},
    },
  );
  const textCalls = ui.calls.filter((call) => call.kind === "text");
  assert.equal(
    DefaultValueSchema.parse(textCalls[1]?.options).defaultValue,
    "https://api.deepseek.com",
  );
  assert.equal(
    DefaultValueSchema.parse(textCalls[2]?.options).defaultValue,
    "deepseek-flash",
  );
  assert.equal(
    reasoningOptions(ui.calls).initialValue,
    "none",
  );
});
