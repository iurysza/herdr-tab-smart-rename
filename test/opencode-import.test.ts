import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importOpenCodeConfig } from "../src/configure.ts";
import {
  AiSdkNamer,
  loadProviderConfig,
  type CompletionRequest,
} from "../src/provider.ts";
import { type NamingContext } from "../src/domain.ts";

const REAL_OPENCODE_PATH = path.join(
  process.env.HOME || "",
  ".config/opencode/opencode.json",
);

const context: NamingContext = {
  project: "Herdr Plugin Dev",
  userRequests: ["Add OpenCode config import command"],
};

async function tempEnv() {
  const root = await mkdtemp(path.join(os.tmpdir(), "smart-rename-opencode-"));
  return {
    root,
    envFile: path.join(root, "provider.env"),
    env: { HERDR_PLUGIN_CONFIG_DIR: root },
  };
}

test("import-opencode writes correct provider.env from real opencode.json", async () => {
  const pluginDir = await tempEnv();
  try {
    await importOpenCodeConfig(pluginDir.env);

    const content = await readFile(pluginDir.envFile, "utf8");
    assert.match(content, /SMART_RENAME_PROVIDER=/);
    assert.match(content, /SMART_RENAME_BASE_URL=/);
    assert.match(content, /SMART_RENAME_MODEL=/);
    assert.match(content, /SMART_RENAME_API_KEY=/);

    const lines = Object.fromEntries(
      content
        .split("\n")
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => {
          const idx = l.indexOf("=");
          return [l.slice(0, idx), l.slice(idx + 1)];
        }),
    );

    const raw = JSON.parse(await readFile(REAL_OPENCODE_PATH, "utf8"));
    const providerKey = Object.keys(raw.provider)[0]!;
    const providerCfg = raw.provider[providerKey];
    const fullModel: string = raw.model;
    const expectedModel = fullModel.includes("/")
      ? fullModel.slice(fullModel.indexOf("/") + 1)
      : fullModel;

    assert.equal(lines["SMART_RENAME_PROVIDER"], providerCfg.name || providerKey);
    assert.equal(lines["SMART_RENAME_BASE_URL"], providerCfg.options.baseURL);
    assert.equal(lines["SMART_RENAME_MODEL"], expectedModel);
    assert.equal(lines["SMART_RENAME_API_KEY"], providerCfg.options.apiKey);
  } finally {
    await rm(pluginDir.root, { recursive: true, force: true });
  }
});

test("imported config loads as valid ProviderConfig with real values", async () => {
  const pluginDir = await tempEnv();
  try {
    await importOpenCodeConfig(pluginDir.env);
    const config = await loadProviderConfig(pluginDir.env);

    const raw = JSON.parse(await readFile(REAL_OPENCODE_PATH, "utf8"));
    const providerKey = Object.keys(raw.provider)[0]!;
    const providerCfg = raw.provider[providerKey];
    const fullModel: string = raw.model;
    const expectedModel = fullModel.includes("/")
      ? fullModel.slice(fullModel.indexOf("/") + 1)
      : fullModel;

    assert.equal(config.provider, providerCfg.name || providerKey);
    assert.equal(config.baseURL, providerCfg.options.baseURL);
    assert.equal(config.model, expectedModel);
    assert.equal(config.apiKey, providerCfg.options.apiKey);
    assert.ok(config.timeoutMs >= 1000 && config.timeoutMs <= 300_000);
  } finally {
    await rm(pluginDir.root, { recursive: true, force: true });
  }
});

test("namer sends correct model ID in completion request using real config", async () => {
  const pluginDir = await tempEnv();
  try {
    await importOpenCodeConfig(pluginDir.env);

    const requests: CompletionRequest[] = [];
    const namer = new AiSdkNamer(pluginDir.env, async (request) => {
      requests.push(request);
      return '{"tab":"Import Config Test","reason":"e2e test"}';
    });
    await namer.suggest(context);

    const raw = JSON.parse(await readFile(REAL_OPENCODE_PATH, "utf8"));
    const providerKey = Object.keys(raw.provider)[0]!;
    const providerCfg = raw.provider[providerKey];
    const fullModel: string = raw.model;
    const expectedModel = fullModel.includes("/")
      ? fullModel.slice(fullModel.indexOf("/") + 1)
      : fullModel;

    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.config.provider, providerCfg.name || providerKey);
    assert.equal(requests[0]!.config.baseURL, providerCfg.options.baseURL);
    assert.equal(requests[0]!.config.model, expectedModel);
    assert.equal(requests[0]!.config.apiKey, providerCfg.options.apiKey);
  } finally {
    await rm(pluginDir.root, { recursive: true, force: true });
  }
});

test("real API request with imported OpenCode config", async () => {
  const pluginDir = await tempEnv();
  try {
    await importOpenCodeConfig(pluginDir.env);
    const config = await loadProviderConfig(pluginDir.env);

    const namer = new AiSdkNamer(pluginDir.env);
    const suggestion = await namer.suggest(context);

    assert.ok(suggestion, "Should return a suggestion");
    if (suggestion.tab !== null) {
      assert.equal(typeof suggestion.tab, "string");
      assert.ok(suggestion.tab.length > 0, "Tab name should not be empty");
      assert.ok(suggestion.tab.length <= 30, `Tab name too long: ${suggestion.tab}`);
    }
    assert.equal(typeof suggestion.reason, "string");
    assert.ok(suggestion.reason.length > 0, "Reason should not be empty");

    console.log(`✓ ${config.provider}/${config.model} → ${JSON.stringify(suggestion)}`);
  } finally {
    await rm(pluginDir.root, { recursive: true, force: true });
  }
}, 120_000);

