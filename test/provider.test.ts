import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureNamingPromptFile,
  ensureProviderFile,
} from "../src/configure.ts";
import {
  AiSdkNamer,
  loadProviderConfig,
  type CompletionRequest,
  transformOpenAiRequestBody,
} from "../src/provider.ts";
import { type NamingContext } from "../src/domain.ts";

const context: NamingContext = {
  project: "Agents",
  userRequests: ["Fix socket reconnect"],
};

async function tempConfig() {
  const root = await mkdtemp(path.join(os.tmpdir(), "smart-rename-provider-"));
  return {
    root,
    file: path.join(root, "provider.env"),
    env: { HERDR_PLUGIN_CONFIG_DIR: root },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function fakeOmp(root: string, behavior: string) {
  const bin = path.join(root, "omp-bin");
  const argsFile = path.join(root, "omp-args.txt");
  const stdinFile = path.join(root, "omp-stdin.txt");
  const executable = path.join(bin, "omp");
  await mkdir(bin, { recursive: true });
  await writeFile(
    executable,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${shellQuote(argsFile)}`,
      `cat > ${shellQuote(stdinFile)}`,
      behavior,
      "",
    ].join("\n"),
  );
  await chmod(executable, 0o700);
  return { bin, argsFile, stdinFile };
}
test("omp provider is keyless while other providers retain validation", async () => {
  const fixture = await tempConfig();
  try {
    const omp = await loadProviderConfig({
      ...fixture.env,
      SMART_RENAME_PROVIDER: "omp",
      SMART_RENAME_MODEL: "local-selector",
    });
    assert.equal(omp.provider, "omp");
    assert.equal(omp.model, "local-selector");
    assert.equal(omp.baseURL, undefined);
    assert.equal(omp.apiKey, undefined);

    await assert.rejects(
      loadProviderConfig({
        ...fixture.env,
        SMART_RENAME_PROVIDER: "openai",
        SMART_RENAME_MODEL: "remote-model",
      }),
      /AI key missing/i,
    );
    await assert.rejects(
      loadProviderConfig({
        ...fixture.env,
        SMART_RENAME_PROVIDER: "openai",
        SMART_RENAME_MODEL: "remote-model",
        SMART_RENAME_API_KEY: "configured-secret-value",
        SMART_RENAME_BASE_URL: "not-a-url",
      }),
      /URL/i,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("omp provider invokes an isolated CLI and sends the request on stdin", async () => {
  if (process.platform === "win32") return;
  const fixture = await tempConfig();
  const promptFile = path.join(fixture.root, "naming-prompt.md");
  try {
    await writeFile(promptFile, "Test naming prompt");
    const fake = await fakeOmp(
      fixture.root,
      `printf '%s\\n' '{"tab":"OMP Task Label","reason":"from omp"}'`,
    );
    const searchPath = `${fake.bin}${path.delimiter}${process.env.PATH || "/usr/bin:/bin"}`;
    const namer = new AiSdkNamer({
      ...fixture.env,
      PATH: searchPath,
      SMART_RENAME_PROVIDER: "omp",
      SMART_RENAME_MODEL: "local-selector",
      SMART_RENAME_REASONING_EFFORT: "low",
      SMART_RENAME_PROMPT_PATH: "naming-prompt.md",
    });

    assert.deepEqual(await namer.suggest(context), {
      tab: "OMP Task Label",
      reason: "from omp",
    });
    assert.deepEqual(
      (await readFile(fake.argsFile, "utf8")).trimEnd().split("\n"),
      [
        "-p",
        "--model",
        "local-selector",
        "--no-session",
        "--no-tools",
        "--no-lsp",
        "--no-extensions",
        "--no-skills",
        "--no-rules",
        "--thinking",
        "low",
      ],
    );
    const stdin = await readFile(fake.stdinFile, "utf8");
    assert.match(stdin, /Test naming prompt/);
    assert.match(stdin, /Agents/);
    assert.match(stdin, /Fix socket reconnect/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("omp failures cancel cleanly and redact configured secrets", async () => {
  if (process.platform === "win32") return;
  const fixture = await tempConfig();
  const secret = "configured-secret-value";
  try {
    const runFailure = async (
      behavior: string,
      pattern: RegExp,
      timeoutMs = "5000",
    ) => {
      const startedAt = performance.now();
      const fake = await fakeOmp(fixture.root, behavior);
      const searchPath = `${fake.bin}${path.delimiter}${process.env.PATH || "/usr/bin:/bin"}`;
      const namer = new AiSdkNamer({
        ...fixture.env,
        PATH: searchPath,
        SMART_RENAME_PROVIDER: "omp",
        SMART_RENAME_MODEL: "local-selector",
        SMART_RENAME_API_KEY: secret,
        SMART_RENAME_TIMEOUT_MS: timeoutMs,
      });
      await assert.rejects(namer.suggest(context), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, pattern);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      });
      return performance.now() - startedAt;
    };

    await runFailure(
      `printf '%s\\n' '${secret} is not JSON'`,
      /JSON|response|model/i,
    );
    await runFailure(
      `printf '%s\\n' '{"tab":"bad","reason":"${secret}"}'`,
      /invalid model tab label/i,
    );
    await runFailure(
      `printf '%s\\n' '${secret} exit 7' >&2\nprintf '%s\\n' '{"tab":"Exit after trigger","reason":"valid JSON after exit trigger"}'\nexit 7`,
      /exit 7/i,
    );
    const timeoutElapsedMs = await runFailure(
      `printf '%s\\n' '${secret} timeout trigger' >&2\nsleep 2\nprintf '%s\\n' '{"tab":"Timeout after trigger","reason":"valid JSON after timeout trigger"}'`,
      /omp request aborted/i,
      "1000",
    );
    assert.ok(
      timeoutElapsedMs < 1800,
      `timeout fixture took ${timeoutElapsedMs.toFixed(0)}ms instead of aborting promptly`,
    );
    await runFailure(
      `printf '%s\\n' '${secret} output limit trigger' >&2\ndd if=/dev/zero bs=1024 count=2048 2>/dev/null\nprintf '%s\\n' '{"tab":"Output limit after trigger","reason":"valid JSON after output limit trigger"}'`,
      /omp stdout output exceeded buffer/i,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("provider config preserves defaults and process-over-file precedence", async () => {
  const fixture = await tempConfig();
  try {
    const defaults = await loadProviderConfig({
      ...fixture.env,
      OPENAI_API_KEY: "standalone-key",
    });
    assert.deepEqual(defaults, {
      provider: "openai",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-5.6-luna",
      timeoutMs: 45_000,
      reasoningEffort: "medium",
      apiKey: "standalone-key",
    });
    await assert.rejects(
      loadProviderConfig({ ...fixture.env, KIMI_API_KEY: "wrong-provider-key" }),
      /AI key missing/,
    );

    await writeFile(
      fixture.file,
      [
        "SMART_RENAME_PROVIDER=file-provider",
        "SMART_RENAME_BASE_URL=https://file.example/v1",
        "SMART_RENAME_MODEL=file-model",
        "SMART_RENAME_TIMEOUT_MS=20000",
        "SMART_RENAME_PROMPT_PATH=prompts/custom.md",
        "SMART_RENAME_API_KEY=file-key",
      ].join("\n"),
    );
    const config = await loadProviderConfig({
      ...fixture.env,
      SMART_RENAME_PROVIDER: "process-provider",
      SMART_RENAME_BASE_URL: "https://process.example/v1/",
      SMART_RENAME_MODEL: "process-model",
      SMART_RENAME_TIMEOUT_MS: "30000",
      SMART_RENAME_API_KEY: "process-key",
    });
    assert.deepEqual(config, {
      provider: "process-provider",
      baseURL: "https://process.example/v1",
      model: "process-model",
      timeoutMs: 30_000,
      promptPath: path.join(fixture.root, "prompts/custom.md"),
      apiKey: "process-key",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("private provider and prompt config enforce templates, permissions, and bounds", async () => {
  const fixture = await tempConfig();
  await rm(fixture.root, { recursive: true, force: true });
  try {
    const file = await ensureProviderFile(fixture.env);
    const prompt = await ensureNamingPromptFile(fixture.env);
    if (process.platform !== "win32") {
      assert.equal((await stat(fixture.root)).mode & 0o777, 0o700);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(prompt)).mode & 0o777, 0o600);
    }
    assert.match(await readFile(file, "utf8"), /SMART_RENAME_MODEL=gpt-5\.6-luna/);
    assert.match(await readFile(prompt, "utf8"), /^# Naming policy/);
    await assert.rejects(loadProviderConfig(fixture.env), /AI key missing.*provider\.env/i);
    await writeFile(file, "x".repeat(16 * 1024 + 1));
    await assert.rejects(loadProviderConfig(fixture.env), /exceeds 16 KiB/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("namer sends one bounded completion and validates model output", async () => {
  const requests: CompletionRequest[] = [];
  const namer = new AiSdkNamer(
    { SMART_RENAME_API_KEY: "standalone-key" },
    async (request) => {
      requests.push(request);
      return '```json\n{"tab":"Repair Socket Reconnect","reason":"current task"}\n```';
    },
  );
  assert.deepEqual(await namer.suggest(context), {
    tab: "Repair Socket Reconnect",
    reason: "current task",
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.config.model, "gpt-5.6-luna");
  assert.equal(requests[0]?.maxOutputTokens, 32_768);
  assert.equal(requests[0]?.config.reasoningEffort, "medium");
  assert.match(requests[0]?.system || "", /^# Naming policy/);
  assert.match(requests[0]?.system || "", /return exactly one JSON object/i);
  assert.ok(requests[0]?.abortSignal instanceof AbortSignal);

  const abstain = new AiSdkNamer(
    { SMART_RENAME_API_KEY: "standalone-key" },
    async () => '{"tab":null,"reason":"no meaningful task"}',
  );
  assert.deepEqual(await abstain.suggest(context), {
    tab: null,
    reason: "no meaningful task",
  });
  const invalid = new AiSdkNamer(
    { SMART_RENAME_API_KEY: "standalone-key" },
    async () => '{"tab":"bad","reason":"bad"}',
  );
  await assert.rejects(invalid.suggest(context), /invalid model tab label/);
});

test("provider transport uses the provider-compatible output-token parameter", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const responseText = '{"tab":"Bound Provider Output","reason":"transport contract"}';
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requestBody = (await request.json()) as Record<string, unknown>;
      if (requestBody.stream === true) {
        const chunk = {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 0,
          model: "test-model",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: responseText },
              finish_reason: "stop",
            },
          ],
        };
        return new Response(
          `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: responseText },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  try {
    const namer = new AiSdkNamer({
      SMART_RENAME_PROVIDER: "test-provider",
      SMART_RENAME_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      SMART_RENAME_MODEL: "test-model",
      SMART_RENAME_API_KEY: "test-key",
      SMART_RENAME_TIMEOUT_MS: "5000",
    });
    assert.deepEqual(await namer.suggest(context), {
      tab: "Bound Provider Output",
      reason: "transport contract",
    });
    assert.equal(requestBody?.max_tokens, 32_768);

    const openaiNamer = new AiSdkNamer({
      SMART_RENAME_PROVIDER: "openai",
      SMART_RENAME_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      SMART_RENAME_MODEL: "gpt-5.6-luna",
      SMART_RENAME_API_KEY: "test-key",
      SMART_RENAME_TIMEOUT_MS: "5000",
    });
    await openaiNamer.suggest(context);
    assert.equal(requestBody?.max_completion_tokens, 32_768);
    assert.equal(requestBody?.max_tokens, undefined);
  } finally {
    server.stop(true);
  }
});

test("OpenAI request transform preserves native completion-token values", () => {
  assert.deepEqual(
    transformOpenAiRequestBody({ model: "m", max_tokens: 5 }),
    { model: "m", max_completion_tokens: 5 },
  );
  assert.deepEqual(
    transformOpenAiRequestBody({ max_tokens: 5, max_completion_tokens: 7 }),
    { max_completion_tokens: 5 },
  );
  assert.deepEqual(
    transformOpenAiRequestBody({ max_completion_tokens: 123 }),
    { max_completion_tokens: 123 },
  );
  assert.deepEqual(
    transformOpenAiRequestBody({ max_tokens: null, max_completion_tokens: 123 }),
    { max_completion_tokens: 123 },
  );
});

test("namer reloads provider.env and naming-prompt.md, then redacts failures", async () => {
  const fixture = await tempConfig();
  const promptFile = path.join(fixture.root, "naming-prompt.md");
  const models: string[] = [];
  const systems: string[] = [];
  try {
    await writeFile(
      fixture.file,
      "SMART_RENAME_API_KEY=first-key\nSMART_RENAME_MODEL=first-model\n",
    );
    await writeFile(promptFile, "First naming prompt");
    const namer = new AiSdkNamer(fixture.env, async (request) => {
      models.push(request.config.model);
      systems.push(request.system);
      return '{"tab":"First Task Name","reason":"task"}';
    });
    await namer.suggest(context);
    await writeFile(
      fixture.file,
      "SMART_RENAME_API_KEY=second-key\nSMART_RENAME_MODEL=second-model\n",
    );
    await writeFile(promptFile, "Second naming prompt");
    await namer.suggest(context);
    assert.deepEqual(models, ["first-model", "second-model"]);
    assert.deepEqual(systems, ["First naming prompt", "Second naming prompt"]);

    const key = "standalone-secret-value";
    const failing = new AiSdkNamer(
      { SMART_RENAME_API_KEY: key },
      async () => {
        throw new Error(`401 Authorization: Bearer ${key}`);
      },
    );
    await assert.rejects(failing.suggest(context), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /AI request failed/);
      assert.doesNotMatch(error.message, new RegExp(key));
      assert.match(error.message, /redacted/);
      return true;
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("manifest uses portable Bun runtime without Pi model coupling", async () => {
  const [manifest, packageSource] = await Promise.all([
    readFile(new URL("../herdr-plugin.toml", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  const packageJson = JSON.parse(packageSource) as { version: string };
  const manifestVersion = manifest.match(/^version = "([^"]+)"$/m)?.[1];

  assert.match(manifest, /^id = "tab-smart-rename"$/m);
  assert.equal(manifestVersion, packageJson.version);
  assert.match(
    manifest,
    /command = \["bun", "install", "--production", "--frozen-lockfile"\]/,
  );
  assert.match(
    manifest,
    /platforms = \["linux", "macos", "windows"\]/,
  );
  assert.match(
    manifest,
    /command = \["bun", "src\/cli\.ts", "start"\]/,
  );
  assert.match(manifest, /id = "provider-config"[\s\S]*placement = "overlay"/);
  assert.match(manifest, /id = "prompt-config"[\s\S]*placement = "overlay"/);

  const src = new URL("../src/", import.meta.url);
  const source = (
    await Promise.all(
      (await readdir(src))
        .filter((file) => file.endsWith(".ts"))
        .map((file) => readFile(new URL(file, src), "utf8")),
    )
  ).join("\n");
  for (const forbidden of ["PiRpc", 'spawn("pi")', '"--mode", "rpc"', "kimi-coding/"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
