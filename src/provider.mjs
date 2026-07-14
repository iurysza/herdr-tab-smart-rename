import { open } from "node:fs/promises";
import path from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { MAX_TAB_LENGTH, parseModelTitle, sanitize } from "./core.mjs";

/**
 * @typedef {object} ProviderConfig
 * @property {string} provider
 * @property {string} baseURL
 * @property {string} model
 * @property {number} timeoutMs
 * @property {string} apiKey
 */

const PROVIDER_ENV_BYTES = 16 * 1024;
export const PROVIDER_ENV_NAME = "provider.env";
export const PROVIDER_DEFAULTS = Object.freeze({
  provider: "kimi-code",
  baseURL: "https://api.kimi.com/coding/v1",
  model: "kimi-for-coding",
  timeoutMs: 45_000,
});

const NAMING_SYSTEM_PROMPT = `Name Herdr task tabs. Return JSON only: {"tab":"...","reason":"..."}, or {"tab":null,"reason":"no meaningful task"} when context has no clear task. The tab is the persistent task only, never an agent/model/app/project prefix. Use 2-4 concrete Title Case words, maximum ${MAX_TAB_LENGTH} characters. Preserve acronyms. Prefer user requests. A sessionTimeline contains origin, middle, and recent requests; use origin and middle for continuity, but recent wins when the task changed. Ignore confirmations and operational follow-ups. Do not invent specificity or repeat the project name as the task.`;

export function providerEnvPath(env = process.env) {
  const directory = env.HERDR_PLUGIN_CONFIG_DIR;
  return directory ? path.join(directory, PROVIDER_ENV_NAME) : null;
}

function parseProviderEnv(text) {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values[match[1]] = value;
  }
  return values;
}

async function readProviderEnv(file) {
  if (!file) return {};
  let handle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  try {
    const buffer = Buffer.alloc(PROVIDER_ENV_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > PROVIDER_ENV_BYTES) {
      throw new Error(`${PROVIDER_ENV_NAME} exceeds 16 KiB`);
    }
    return parseProviderEnv(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}

function pick(processEnv, fileEnv, name, fallback) {
  return processEnv[name] || fileEnv[name] || fallback;
}

function validateBaseURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SMART_RENAME_BASE_URL must be a valid URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("SMART_RENAME_BASE_URL must be an HTTP(S) URL without credentials");
  }
  return value.replace(/\/$/, "");
}

function validateProviderConfig(config) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.provider)) {
    throw new Error("SMART_RENAME_PROVIDER is invalid");
  }
  config.baseURL = validateBaseURL(config.baseURL);
  if (!config.model || /[\r\n]/.test(config.model)) {
    throw new Error("SMART_RENAME_MODEL is required");
  }
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1_000 || config.timeoutMs > 300_000) {
    throw new Error("SMART_RENAME_TIMEOUT_MS must be 1000-300000");
  }
  if (!config.apiKey) {
    throw new Error(
      `AI key missing. Run configure-ai or set SMART_RENAME_API_KEY in ${PROVIDER_ENV_NAME}`,
    );
  }
  return config;
}

/** @returns {Promise<ProviderConfig>} */
export async function loadProviderConfig(env = process.env) {
  const fileEnv = await readProviderEnv(providerEnvPath(env));
  const timeoutRaw = pick(
    env,
    fileEnv,
    "SMART_RENAME_TIMEOUT_MS",
    String(PROVIDER_DEFAULTS.timeoutMs),
  );
  const config = {
    provider: pick(env, fileEnv, "SMART_RENAME_PROVIDER", PROVIDER_DEFAULTS.provider),
    baseURL: pick(env, fileEnv, "SMART_RENAME_BASE_URL", PROVIDER_DEFAULTS.baseURL),
    model: pick(env, fileEnv, "SMART_RENAME_MODEL", PROVIDER_DEFAULTS.model),
    timeoutMs: Number(timeoutRaw),
    apiKey:
      env.SMART_RENAME_API_KEY ||
      fileEnv.SMART_RENAME_API_KEY ||
      env.KIMI_API_KEY ||
      fileEnv.KIMI_API_KEY ||
      "",
  };
  return validateProviderConfig(config);
}

function safeProviderError(error, config) {
  let message = String(error?.message || error || "provider request failed");
  for (const secret of [config.apiKey]) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  return sanitize(message).slice(0, 400) || "provider request failed";
}

export class AiSdkNamer {
  constructor(
    env = process.env,
    { generate = generateText, createProvider = createOpenAICompatible, fetch } = {},
  ) {
    this.env = env;
    this.generate = generate;
    this.createProvider = createProvider;
    this.fetch = fetch;
  }

  async suggest(context) {
    const config = await loadProviderConfig(this.env);
    try {
      const provider = this.createProvider({
        name: config.provider,
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        ...(this.fetch ? { fetch: this.fetch } : {}),
      });
      const result = await this.generate({
        model: provider(config.model),
        system: NAMING_SYSTEM_PROMPT,
        prompt: `Suggest one label from this sanitized context:\n${JSON.stringify(context)}`,
        maxOutputTokens: 120,
        temperature: 0.2,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(config.timeoutMs),
      });
      return parseModelTitle(result.text);
    } catch (error) {
      throw new Error(
        `AI request failed (${config.provider}/${config.model}): ${safeProviderError(error, config)}`,
      );
    }
  }

}
