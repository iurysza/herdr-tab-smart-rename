import { test } from "bun:test";
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PiModelSource } from "../src/model-sources/pi.ts";
import { OpenCodeModelSource } from "../src/model-sources/opencode.ts";

const contained = process.env.SMART_RENAME_HARNESS_TEST === "1";
const runtimeTest = contained ? test : test.skip;

function fakeProvider(toolSentinel?: string) {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (!request.url.endsWith("/chat/completions")) return new Response("unexpected route", { status: 404 });
      const body = await request.json() as Record<string, unknown>;
      requests.push(body);
      const text = '{"tab":"Repair Reconnect","reason":"task"}';
      const base = { id: "fixture", model: "naming-fixture", created: 0 };
      if (toolSentinel && requests.length === 1) {
        const call = { index: 0, id: "sentinel-tool", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `printf unexpected > '${toolSentinel}'`, description: "Write a test sentinel" }) } };
        return new Response([
          { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }] },
          { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      }
      if (body.stream) {
        return new Response([
          { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
          { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    },
  });
  return { server, requests };
}

for (const requestTool of [false, true]) runtimeTest(`real OpenCode reuses its provider${requestTool ? " and denies a model-requested tool" : ""}`, async () => {
  const sentinel = path.join(process.env.HOME!, "tool-sentinel");
  const { server, requests } = fakeProvider(requestTool ? sentinel : undefined);
  const configRoot = path.join(process.env.XDG_CONFIG_HOME!, "opencode");
  await mkdir(configRoot, { recursive: true });
  await writeFile(path.join(configRoot, "opencode.json"), JSON.stringify({
    provider: {
      fixture: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local fixture",
        options: { baseURL: `${server.url}v1`, apiKey: "fixture-not-a-real-key" },
        models: { "naming-fixture": { name: "Naming fixture", limit: { context: 32768, output: 32768 } } },
      },
    },
    share: "disabled",
    autoupdate: false,
  }));
  const source = new OpenCodeModelSource(undefined, process.env.HOME!);
  try {
    const providers = await source.listProviders();
    assert.ok(providers.some((provider) => provider.id === "fixture"));
    const text = await source.complete({
      selection: { version: 1, source: "opencode", provider: "fixture", model: "naming-fixture" },
      context: { project: "Plugin", userRequests: ["Repair reconnect"] },
      system: "Return only a JSON tab label. Do not use tools.",
      prompt: "Name the task: repair reconnect",
      maxOutputTokens: 32768, maxRetries: 1, abortSignal: AbortSignal.timeout(45_000),
    });
    assert.equal(JSON.parse(text).tab, "Repair Reconnect");
    assert.ok(requests.length > 0);
    assert.equal(requests.at(-1)?.model, "naming-fixture");
    if (requestTool) {
      assert.ok(requests.length >= 2, "OpenCode must handle the requested tool before the final reply");
      await assert.rejects(access(sentinel), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    }
  } finally {
    await source.close();
    server.stop(true);
  }
}, 45_000);

runtimeTest("real Pi runtime reuses its configured provider without Smart Rename owning a key", async () => {
  const { server, requests } = fakeProvider();
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
    fixture: { baseUrl: `${server.url}v1`, api: "openai-completions", apiKey: "fixture-not-a-real-key", models: [{ id: "naming-fixture" }] },
  } }));
  const source = new PiModelSource();
  try {
    assert.ok((await source.listProviders()).some((provider) => provider.id === "fixture"));
    const text = await source.complete({
      selection: { version: 1, source: "pi", provider: "fixture", model: "naming-fixture" },
      context: { project: "Plugin", userRequests: ["Repair reconnect"] },
      system: "Return a JSON tab label.", prompt: "Name the task: repair reconnect",
      maxOutputTokens: 32768, maxRetries: 1, abortSignal: AbortSignal.timeout(45_000),
    });
    assert.equal(JSON.parse(text).tab, "Repair Reconnect");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.model, "naming-fixture");
  } finally { server.stop(true); }
}, 45_000);
