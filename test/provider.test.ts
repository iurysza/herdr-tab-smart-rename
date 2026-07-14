import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureProviderFile } from "../src/configure.ts";
import {
  AiSdkNamer,
  PROVIDER_DEFAULTS,
  loadProviderConfig,
  type CompletionRequest,
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

test("provider config preserves defaults and process-over-file precedence", async () => {
  const fixture = await tempConfig();
  try {
    const defaults = await loadProviderConfig({
      ...fixture.env,
      SMART_RENAME_API_KEY: "standalone-key",
    });
    assert.deepEqual(
      {
        provider: defaults.provider,
        baseURL: defaults.baseURL,
        model: defaults.model,
        timeoutMs: defaults.timeoutMs,
        reasoningEffort: defaults.reasoningEffort,
      },
      PROVIDER_DEFAULTS,
    );

    await writeFile(
      fixture.file,
      [
        "SMART_RENAME_PROVIDER=file-provider",
        "SMART_RENAME_BASE_URL=https://file.example/v1",
        "SMART_RENAME_MODEL=file-model",
        "SMART_RENAME_TIMEOUT_MS=20000",
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
      apiKey: "process-key",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("private provider config enforces permissions, key presence, and 16 KiB bound", async () => {
  const fixture = await tempConfig();
  await rm(fixture.root, { recursive: true, force: true });
  try {
    const file = await ensureProviderFile(fixture.env);
    assert.equal((await stat(fixture.root)).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
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
  assert.equal(requests[0]?.config.model, "kimi-for-coding");
  assert.equal(requests[0]?.maxOutputTokens, 32_768);
  assert.equal(requests[0]?.config.reasoningEffort, "medium");
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

test("namer reloads provider.env and redacts configured keys from failures", async () => {
  const fixture = await tempConfig();
  const models: string[] = [];
  try {
    await writeFile(
      fixture.file,
      "SMART_RENAME_API_KEY=first-key\nSMART_RENAME_MODEL=first-model\n",
    );
    const namer = new AiSdkNamer(fixture.env, async (request) => {
      models.push(request.config.model);
      return '{"tab":"First Task Name","reason":"task"}';
    });
    await namer.suggest(context);
    await writeFile(
      fixture.file,
      "SMART_RENAME_API_KEY=second-key\nSMART_RENAME_MODEL=second-model\n",
    );
    await namer.suggest(context);
    assert.deepEqual(models, ["first-model", "second-model"]);

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

test("manifest and source use Bun without Pi model coupling", async () => {
  const manifest = await readFile(
    new URL("../herdr-plugin.toml", import.meta.url),
    "utf8",
  );
  assert.match(
    manifest,
    /command = \["bun", "install", "--production", "--frozen-lockfile"\]/,
  );
  assert.match(manifest, /command = \["bun", "src\/cli\.ts", "start"\]/);
  assert.match(manifest, /id = "provider-config"[\s\S]*placement = "overlay"/);

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
