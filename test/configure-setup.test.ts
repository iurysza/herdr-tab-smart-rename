import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveDirectProviderConfig } from "../src/configure.ts";
import { loadProviderConfig } from "../src/provider.ts";

for (const apiKey of ["fixture-key", "fixture#fragment", "fixture with spaces", 'fixture"quote', "fixture\\literal"]) {
  test(`Direct setup preserves an opaque key ${JSON.stringify(apiKey)}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "smart-rename-config-"));
    const env = { HERDR_PLUGIN_CONFIG_DIR: root };
    try {
      await saveDirectProviderConfig({ provider: "openai", baseURL: "https://api.openai.com/v1", model: "gpt-5.6-luna", apiKey, timeoutMs: 45000 }, env);
      const config = await loadProviderConfig(env);
      assert.equal(config.apiKey, apiKey);
      assert.equal(config.reasoningEffort, undefined, "None must not reload the default medium reasoning");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
