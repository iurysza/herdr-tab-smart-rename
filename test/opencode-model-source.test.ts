import { test } from "bun:test";
import assert from "node:assert/strict";
import { OpenCodeModelSource } from "../src/model-sources/opencode.ts";
import { ModelSourceError } from "../src/model-source.ts";

function fixture(
  { failPrompt = false, hangPrompt = false, hangStage }: { failPrompt?: boolean; hangPrompt?: boolean; hangStage?: "catalog" | "tools" | "create" | "delete" } = {},
) {
  const calls: Array<{ type: string; value?: unknown; options?: unknown }> = [];
  let closed = 0;
  let signalPromptStarted: (() => void) | undefined;
  const promptStarted = new Promise<void>((resolve) => {
    signalPromptStarted = resolve;
  });
  async function pause(stage: typeof hangStage, signal?: AbortSignal): Promise<void> {
    if (!hangStage || stage !== hangStage) return;
    signalPromptStarted?.();
    assert.ok(signal, `${stage} must receive the caller cancellation signal`);
    signal.throwIfAborted();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
  const source = new OpenCodeModelSource(
    async () => ({
      server: {
        close: () => {
          closed += 1;
        },
      },
      client: {
        provider: {
          list: async (_input, options) => {
            await pause("catalog", options?.signal);
            return { data: {
              connected: ["openai"],
              all: [
                {
                  id: "openai",
                  name: "OpenAI",
                  models: {
                    "gpt-5.6": {
                      id: "gpt-5.6",
                      name: "GPT-5.6",
                      variants: {
                        fast: {},
                        retired: { disabled: true },
                      },
                    },
                  },
                },
                {
                  id: "anthropic",
                  name: "Anthropic",
                  models: {
                    claude: { id: "claude", name: "Claude" },
                  },
                },
              ],
            } };
          },
        },
        tool: {
          ids: async (value, options) => {
            await pause("tools", options?.signal);
            calls.push({ type: "tool-ids", value });
            return { data: ["bash", "read", "mcp_lookup"] };
          },
        },
        session: {
          create: async (value, options) => {
            await pause("create", options?.signal);
            calls.push({ type: "create", value });
            return { data: { id: "temporary" } };
          },
          prompt: async (value, options) => {
            calls.push({ type: "prompt", value, options });
            if (failPrompt) throw new Error("network failed");
            if (hangPrompt) {
              signalPromptStarted?.();
              await new Promise<void>((_resolve, reject) => {
                options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
              });
            }
            return {
              data: {
                parts: [
                  { type: "reasoning", text: "hidden" },
                  { type: "text", text: '{"tab":"Repair Socket Reconnect","reason":"task"}' },
                ],
              },
            };
          },
          delete: async (value, options) => {
            await pause("delete", options?.signal);
            calls.push({ type: "delete", value });
          },
        },
      },
    }),
    "/project",
  );
  return { source, calls, closed: () => closed, promptStarted };
}

const selection = {
  version: 1 as const,
  source: "opencode" as const,
  provider: "openai",
  model: "gpt-5.6",
  profile: "fast",
};

test("OpenCode v2 exposes only connected providers and supported variants", async () => {
  const { source } = fixture();
  assert.deepEqual(await source.listProviders(), [{ id: "openai", label: "OpenAI" }]);
  assert.deepEqual(await source.listModels("openai"), [
    { id: "gpt-5.6", label: "GPT-5.6" },
  ]);
  assert.deepEqual(await source.listProfiles("openai", "gpt-5.6"), [
    { id: "fast", label: "fast" },
  ]);
  await assert.rejects(source.listModels("anthropic"), /not connected/);
});

test("OpenCode disables enumerated tools, denies execution, and deletes its session", async () => {
  const { source, calls, closed } = fixture();
  const abort = AbortSignal.timeout(1_000);
  const text = await source.complete({
    selection,
    context: { project: "Plugin", userRequests: ["Fix reconnect"] },
    system: "JSON only",
    prompt: "Name this task",
    maxOutputTokens: 123,
    maxRetries: 1,
    abortSignal: abort,
  });
  assert.match(text, /Repair Socket Reconnect/);
  assert.deepEqual(calls, [
    {
      type: "tool-ids",
      value: { directory: "/project" },
    },
    {
      type: "create",
      value: {
        directory: "/project",
        title: "Smart Rename",
        model: { providerID: "openai", id: "gpt-5.6", variant: "fast" },
        permission: [{ permission: "*", pattern: "*", action: "deny" }],
      },
    },
    {
      type: "prompt",
      value: {
        sessionID: "temporary",
        directory: "/project",
        model: { providerID: "openai", modelID: "gpt-5.6" },
        system: "JSON only",
        variant: "fast",
        tools: { bash: false, read: false, mcp_lookup: false },
        parts: [{ type: "text", text: "Name this task" }],
      },
      options: { signal: abort },
    },
    { type: "delete", value: { sessionID: "temporary", directory: "/project" } },
  ]);
  await source.close();
  await source.close();
  assert.equal(closed(), 1);
});

test("OpenCode sends the caller abort signal to the SDK and deletes a hung temporary session", async () => {
  const { source, calls, promptStarted } = fixture({ hangPrompt: true });
  const abort = new AbortController();
  const completion = source.complete({
    selection,
    context: { project: "Plugin", userRequests: ["Fix reconnect"] },
    system: "JSON only",
    prompt: "Name this task",
    maxOutputTokens: 123,
    maxRetries: 1,
    abortSignal: abort.signal,
  });
  await promptStarted;
  abort.abort(new Error("test cancellation"));
  await assert.rejects(completion, ModelSourceError);
  assert.deepEqual(calls.find((call) => call.type === "prompt")?.options, {
    signal: abort.signal,
  });
  assert.equal(calls.at(-1)?.type, "delete");
});

test("OpenCode deletes temporary sessions when a request fails", async () => {
  const { source, calls } = fixture({ failPrompt: true });
  await assert.rejects(
    source.complete({
      selection,
      context: { project: "Plugin", userRequests: ["Fix reconnect"] },
      system: "JSON only",
      prompt: "Name this task",
      maxOutputTokens: 123,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(1_000),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ModelSourceError);
      assert.match(error.message, /OpenCode request failed/);
      return true;
    },
  );
  assert.equal(calls.at(-1)?.type, "delete");
});

for (const hangStage of ["catalog", "tools", "create", "delete"] as const) {
  test(`OpenCode cancellation reaches ${hangStage} and closes the owned server`, async () => {
    const { source, promptStarted, closed } = fixture({ hangStage });
    const abort = new AbortController();
    const completion = source.complete({ selection, context: { project: "Plugin", userRequests: ["Name task"] }, system: "JSON only", prompt: "Name task", maxOutputTokens: 123, maxRetries: 1, abortSignal: abort.signal });
    const settled = completion.then(() => "completed", () => "failed");
    await promptStarted;
    abort.abort(new Error("test cancellation"));
    await settled;
    assert.equal(closed(), 1);
  });
}
