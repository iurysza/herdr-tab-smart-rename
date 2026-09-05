import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  PiModelSource,
  type PiRuntime,
} from "../src/model-sources/pi.ts";
import { ModelSourceError } from "../src/model-source.ts";

const model = {
  provider: "anthropic",
  id: "claude-sonnet",
  name: "Claude Sonnet",
  reasoning: true,
};

function source(runtime: PiRuntime = runtimeWithModel()): PiModelSource {
  return new PiModelSource(async () => ({
    runtime,
    profiles: (item) => (item.reasoning ? ["off", "low", "high"] : []),
  }));
}

function runtimeWithModel(): PiRuntime {
  return {
    getAvailable: async (provider) => (!provider || provider === model.provider ? [model] : []),
    getModel: (provider, id) =>
      provider === model.provider && id === model.id ? model : undefined,
    completeSimple: async () => ({
      content: [{ type: "text", text: '{"tab":"Repair Socket Reconnect","reason":"task"}' }],
      stopReason: "stop",
    }),
  };
}

test("Pi exposes only authenticated providers and their staged model profiles", async () => {
  const adapter = source();
  assert.deepEqual(await adapter.listProviders(), [
    { id: "anthropic", label: "anthropic" },
  ]);
  assert.deepEqual(await adapter.listModels("anthropic"), [
    { id: "claude-sonnet", label: "Claude Sonnet" },
  ]);
  assert.deepEqual(await adapter.listProfiles("anthropic", "claude-sonnet"), [
    { id: "off", label: "off" },
    { id: "low", label: "low" },
    { id: "high", label: "high" },
  ]);
  await assert.rejects(adapter.listModels("openai"), /Pi provider is not connected/);
});

test("Pi completion uses Pi-owned model and thinking configuration", async () => {
  const calls: Array<{ model: string; context: unknown; options: unknown }> = [];
  const adapter = source({
    ...runtimeWithModel(),
    completeSimple: async (selected, context, options) => {
      calls.push({ model: selected.id, context, options });
      return {
        content: [{ type: "text", text: '{"tab":"Repair Socket Reconnect","reason":"task"}' }],
        stopReason: "stop",
      };
    },
  });
  const text = await adapter.complete({
    selection: {
      version: 1,
      source: "pi",
      provider: "anthropic",
      model: "claude-sonnet",
      profile: "high",
    },
    context: { project: "Plugin", userRequests: ["Fix reconnect"] },
    system: "JSON only",
    prompt: "Name this task",
    maxOutputTokens: 123,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(1_000),
  });
  assert.match(text, /Repair Socket Reconnect/);
  assert.deepEqual(calls[0]?.options, {
    reasoning: "high",
    maxTokens: 123,
    maxRetries: 1,
    signal: calls[0] && (calls[0].options as { signal: AbortSignal }).signal,
  });
  assert.deepEqual(calls[0]?.context, {
    systemPrompt: "JSON only",
    messages: [
      {
        role: "user",
        content: "Name this task",
        timestamp: (calls[0]?.context as { messages: Array<{ timestamp: number }> }).messages[0]?.timestamp,
      },
    ],
  });
});

test("Pi failures are fail-closed and secret-free", async () => {
  const adapter = source({
    getAvailable: async () => [],
    getModel: () => model,
    completeSimple: async () => {
      throw new Error("Bearer private-token");
    },
  });
  await assert.rejects(
    adapter.complete({
      selection: {
        version: 1,
        source: "pi",
        provider: "anthropic",
        model: "claude-sonnet",
      },
      context: { project: "Plugin", userRequests: ["Fix reconnect"] },
      system: "JSON only",
      prompt: "Name this task",
      maxOutputTokens: 123,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(1_000),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ModelSourceError);
      assert.match(error.message, /not connected/);
      assert.doesNotMatch(error.message, /private-token/);
      return true;
    },
  );
});
