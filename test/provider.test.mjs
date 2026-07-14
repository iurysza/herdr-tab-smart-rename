import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureProviderFile } from "../src/configure.mjs";
import {
  AiSdkNamer,
  PROVIDER_DEFAULTS,
  loadProviderConfig,
  readProviderEnv,
} from "../src/provider.mjs";

async function tempConfig() {
  const root = await mkdtemp(path.join(os.tmpdir(), "smart-rename-provider-"));
  return {
    root,
    file: path.join(root, "provider.env"),
    env: { HERDR_PLUGIN_CONFIG_DIR: root },
  };
}

test("provider config uses Kimi Code defaults", async () => {
  const fixture = await tempConfig();
  try {
    const config = await loadProviderConfig({
      ...fixture.env,
      SMART_RENAME_API_KEY: "standalone-key",
    });
    assert.deepEqual(
      {
        provider: config.provider,
        baseURL: config.baseURL,
        model: config.model,
        timeoutMs: config.timeoutMs,
      },
      PROVIDER_DEFAULTS,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("process config overrides provider.env and Smart Rename key wins", async () => {
  const fixture = await tempConfig();
  try {
    await writeFile(
      fixture.file,
      [
        "SMART_RENAME_PROVIDER=file-provider",
        "SMART_RENAME_BASE_URL=https://file.example/v1",
        "SMART_RENAME_MODEL=file-model",
        "SMART_RENAME_TIMEOUT_MS=20000",
        "SMART_RENAME_API_KEY=file-smart-key",
        "KIMI_API_KEY=file-kimi-key",
        "",
      ].join("\n"),
    );
    const config = await loadProviderConfig({
      ...fixture.env,
      SMART_RENAME_PROVIDER: "process-provider",
      SMART_RENAME_BASE_URL: "https://process.example/v1",
      SMART_RENAME_MODEL: "process-model",
      SMART_RENAME_TIMEOUT_MS: "30000",
      SMART_RENAME_API_KEY: "process-smart-key",
      KIMI_API_KEY: "process-kimi-key",
    });
    assert.equal(config.provider, "process-provider");
    assert.equal(config.baseURL, "https://process.example/v1");
    assert.equal(config.model, "process-model");
    assert.equal(config.timeoutMs, 30_000);
    assert.equal(config.apiKey, "process-smart-key");

    const fileSmart = await loadProviderConfig({
      ...fixture.env,
      KIMI_API_KEY: "process-kimi-key",
    });
    assert.equal(fileSmart.apiKey, "file-smart-key");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("KIMI_API_KEY process fallback outranks file fallback", async () => {
  const fixture = await tempConfig();
  try {
    await writeFile(fixture.file, "KIMI_API_KEY=file-kimi-key\n");
    const config = await loadProviderConfig({
      ...fixture.env,
      KIMI_API_KEY: "process-kimi-key",
    });
    assert.equal(config.apiKey, "process-kimi-key");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("missing key explains private provider configuration", async () => {
  const fixture = await tempConfig();
  try {
    await assert.rejects(loadProviderConfig(fixture.env), /configure-ai.*SMART_RENAME_API_KEY.*provider\.env/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("provider.env reads are capped at 16 KiB", async () => {
  const fixture = await tempConfig();
  try {
    await writeFile(fixture.file, "x".repeat(16 * 1024 + 1));
    await assert.rejects(readProviderEnv(fixture.file), /exceeds 16 KiB/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("configure creates private config directory and file", async () => {
  const fixture = await tempConfig();
  await rm(fixture.root, { recursive: true, force: true });
  try {
    const file = await ensureProviderFile(fixture.env);
    assert.equal((await stat(fixture.root)).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.match(await readFile(file, "utf8"), /SMART_RENAME_API_KEY=/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("AiSdkNamer makes one bounded non-streaming generation", async () => {
  const calls = [];
  const namer = new AiSdkNamer(
    { SMART_RENAME_API_KEY: "standalone-key" },
    {
      createProvider: (settings) => {
        calls.push({ settings });
        return (model) => ({ model });
      },
      generate: async (options) => {
        calls.push({ options });
        return { text: '{"tab":"Repair Socket Reconnect","reason":"current task"}' };
      },
    },
  );
  const result = await namer.suggest({ userRequests: ["Fix socket reconnect"] });
  assert.deepEqual(result, { tab: "Repair Socket Reconnect", reason: "current task" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].settings.name, "kimi-code");
  assert.equal(calls[0].settings.baseURL, "https://api.kimi.com/coding/v1");
  assert.equal(calls[1].options.model.model, "kimi-for-coding");
  assert.equal(calls[1].options.maxOutputTokens, 120);
  assert.equal(calls[1].options.temperature, 0.2);
  assert.ok(calls[1].options.abortSignal instanceof AbortSignal);
});

test("AiSdkNamer rejects invalid model JSON through title validation", async () => {
  const namer = new AiSdkNamer(
    { SMART_RENAME_API_KEY: "standalone-key" },
    {
      createProvider: () => () => ({}),
      generate: async () => ({ text: '{"tab":"bad","reason":"bad"}' }),
    },
  );
  await assert.rejects(namer.suggest({}), /invalid model tab label/);
});

test("provider failures never expose the configured key", async () => {
  const key = "standalone-secret-value";
  const namer = new AiSdkNamer(
    { SMART_RENAME_API_KEY: key },
    {
      createProvider: () => () => ({}),
      generate: async () => {
        throw new Error(`401 Authorization: Bearer ${key}`);
      },
    },
  );
  await assert.rejects(namer.suggest({}), (error) => {
    assert.match(error.message, /AI request failed/);
    assert.doesNotMatch(error.message, new RegExp(key));
    assert.match(error.message, /redacted/);
    return true;
  });
});

test("AiSdkNamer reloads provider.env before every request", async () => {
  const fixture = await tempConfig();
  const settings = [];
  try {
    await writeFile(fixture.file, "SMART_RENAME_API_KEY=first-key\nSMART_RENAME_MODEL=first-model\n");
    const namer = new AiSdkNamer(fixture.env, {
      createProvider: (value) => {
        settings.push(value);
        return (model) => ({ model });
      },
      generate: async () => ({ text: '{"tab":"First Task Name","reason":"task"}' }),
    });
    await namer.suggest({});
    await writeFile(fixture.file, "SMART_RENAME_API_KEY=second-key\nSMART_RENAME_MODEL=second-model\n");
    await namer.suggest({});
    assert.deepEqual(
      settings.map(({ apiKey }) => apiKey),
      ["first-key", "second-key"],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("manifest registers configure/check actions and provider pane", async () => {
  const manifest = await readFile(new URL("../herdr-plugin.toml", import.meta.url), "utf8");
  assert.match(manifest, /id = "configure-ai"/);
  assert.match(manifest, /id = "check-ai"/);
  assert.match(manifest, /id = "provider-config"/);
  assert.match(manifest, /placement = "overlay"/);
  assert.match(manifest, /\[\[build\]\]\ncommand = \["npm", "ci", "--omit=dev"\]/);
});

test("source contains no Pi model invocation path", async () => {
  const files = ["integrations.mjs", "cli.mjs", "service.mjs", "worker.mjs"];
  const source = (
    await Promise.all(
      files.map((file) => readFile(new URL(`../src/${file}`, import.meta.url), "utf8")),
    )
  ).join("\n");
  for (const forbidden of ['spawn("pi")', "PiRpc", '"--mode",\n        "rpc"', "kimi-coding/"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
