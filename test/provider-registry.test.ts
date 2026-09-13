import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DIRECT_PROVIDER_ID,
  defaultDirectProviderProfile,
  directProviderProfile,
  directProviderProfiles,
} from "../src/provider-registry.ts";

test("OpenAI is the registered default direct provider", () => {
  assert.equal(DEFAULT_DIRECT_PROVIDER_ID, "openai");
  assert.deepEqual(defaultDirectProviderProfile(), {
    id: "openai",
    label: "OpenAI",
    defaultBaseURL: "https://api.openai.com/v1",
    defaultModel: "gpt-5.6-luna",
    defaultReasoningEffort: "medium",
    apiKeyEnvNames: ["OPENAI_API_KEY"],
  });
  assert.equal(directProviderProfiles()[0]?.id, DEFAULT_DIRECT_PROVIDER_ID);
});

test("direct provider profiles centralize key aliases and optional defaults", () => {
  assert.deepEqual(directProviderProfile("kimi-code"), {
    id: "kimi-code",
    label: "Kimi Code",
    apiKeyEnvNames: ["KIMI_API_KEY"],
  });
  assert.equal(directProviderProfile("custom-provider"), undefined);
});

test("DeepSeek is a registered OpenAI-compatible provider profile", () => {
  assert.deepEqual(directProviderProfile("deepseek"), {
    id: "deepseek",
    label: "DeepSeek",
    defaultBaseURL: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-flash",
    apiKeyEnvNames: ["DEEPSEEK_API_KEY"],
  });
});
