import path from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { parse as parseEnv } from "dotenv";
import { z } from "zod";
import {
  MAX_TAB_LENGTH,
  type NameSuggestion,
  type NamingContext,
  validateTabLabel,
} from "./domain.ts";
import { sanitizeText } from "./text.ts";

const PROVIDER_ENV_BYTES = 16 * 1024;
export const PROVIDER_ENV_NAME = "provider.env";
export const PROVIDER_DEFAULTS = Object.freeze({
  provider: "kimi-code",
  baseURL: "https://api.kimi.com/coding/v1",
  model: "kimi-for-coding",
  timeoutMs: 45_000,
  reasoningEffort: "medium" as const,
});

const NAMING_SYSTEM_PROMPT = `Name Herdr task tabs. Return JSON only: {"tab":"...","reason":"..."}, or {"tab":null,"reason":"no meaningful task"} when context has no clear task. The tab is the persistent task only, never an agent/model/app/project prefix. Use 2-4 concrete Title Case words, maximum ${MAX_TAB_LENGTH} characters. Preserve acronyms. Prefer user requests. A sessionTimeline contains origin, middle, and recent requests; use origin and middle for continuity, but recent wins when the task changed. Ignore confirmations and operational follow-ups. Do not invent specificity or repeat the project name as the task.`;

const ProviderConfigSchema = z.object({
  provider: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  baseURL: z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
    })
    .transform((value) => value.replace(/\/$/, "")),
  model: z.string().min(1).refine((value) => !/[\r\n]/.test(value)),
  timeoutMs: z.number().int().min(1_000).max(300_000),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  apiKey: z.string().min(1),
});

const ModelOutputSchema = z.object({
  tab: z.string().nullable(),
  reason: z.string(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export interface Namer {
  suggest(context: NamingContext): Promise<NameSuggestion>;
}

export function providerEnvPath(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.HERDR_PLUGIN_CONFIG_DIR
    ? path.join(env.HERDR_PLUGIN_CONFIG_DIR, PROVIDER_ENV_NAME)
    : null;
}

async function readProviderEnv(filePath: string | null): Promise<Record<string, string>> {
  if (!filePath) return {};
  const file = Bun.file(filePath);
  if (!(await file.exists())) return {};
  if (file.size > PROVIDER_ENV_BYTES) {
    throw new Error(`${PROVIDER_ENV_NAME} exceeds 16 KiB`);
  }
  return parseEnv(await file.text());
}

function pick(
  processEnv: NodeJS.ProcessEnv,
  fileEnv: Record<string, string>,
  name: string,
  fallback: string,
): string {
  return processEnv[name] || fileEnv[name] || fallback;
}

function configError(error: z.ZodError): Error {
  const field = error.issues[0]?.path[0];
  const messages: Record<PropertyKey, string> = {
    provider: "SMART_RENAME_PROVIDER is invalid",
    baseURL: "SMART_RENAME_BASE_URL must be an HTTP(S) URL without credentials",
    model: "SMART_RENAME_MODEL is required",
    timeoutMs: "SMART_RENAME_TIMEOUT_MS must be 1000-300000",
    reasoningEffort: "SMART_RENAME_REASONING_EFFORT must be low, medium, or high",
    apiKey: `AI key missing. Run configure-ai or set SMART_RENAME_API_KEY in ${PROVIDER_ENV_NAME}`,
  };
  return new Error(messages[field ?? ""] ?? "AI provider configuration is invalid");
}

export async function loadProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderConfig> {
  const fileEnv = await readProviderEnv(providerEnvPath(env));
  const provider = pick(
    env,
    fileEnv,
    "SMART_RENAME_PROVIDER",
    PROVIDER_DEFAULTS.provider,
  );
  const reasoningEffort = pick(
    env,
    fileEnv,
    "SMART_RENAME_REASONING_EFFORT",
    provider === PROVIDER_DEFAULTS.provider
      ? PROVIDER_DEFAULTS.reasoningEffort
      : "",
  );
  const input = {
    provider,
    baseURL: pick(env, fileEnv, "SMART_RENAME_BASE_URL", PROVIDER_DEFAULTS.baseURL),
    model: pick(env, fileEnv, "SMART_RENAME_MODEL", PROVIDER_DEFAULTS.model),
    timeoutMs: Number(
      pick(
        env,
        fileEnv,
        "SMART_RENAME_TIMEOUT_MS",
        String(PROVIDER_DEFAULTS.timeoutMs),
      ),
    ),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    apiKey:
      env.SMART_RENAME_API_KEY ||
      fileEnv.SMART_RENAME_API_KEY ||
      env.KIMI_API_KEY ||
      fileEnv.KIMI_API_KEY ||
      "",
  };
  const parsed = ProviderConfigSchema.safeParse(input);
  if (!parsed.success) throw configError(parsed.error);
  return parsed.data;
}

function parseSuggestion(text: string): NameSuggestion {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const output = ModelOutputSchema.parse(JSON.parse(cleaned));
  if (output.tab === null) {
    return { tab: null, reason: sanitizeText(output.reason) };
  }
  if (!validateTabLabel(output.tab)) {
    throw new Error(`invalid model tab label: ${JSON.stringify(output.tab)}`);
  }
  return { tab: sanitizeText(output.tab), reason: sanitizeText(output.reason) };
}

function safeProviderError(error: unknown, config: ProviderConfig): string {
  let message = error instanceof Error ? error.message : String(error || "provider request failed");
  message = message.replaceAll(config.apiKey, "[redacted]");
  return sanitizeText(message).slice(0, 400) || "provider request failed";
}

export interface CompletionRequest {
  config: ProviderConfig;
  context: NamingContext;
  system: string;
  maxOutputTokens: 32_768;
  maxRetries: 1;
  abortSignal: AbortSignal;
}

type Complete = (request: CompletionRequest) => Promise<string>;

async function completeWithAiSdk(request: CompletionRequest): Promise<string> {
  const provider = createOpenAICompatible({
    name: request.config.provider,
    baseURL: request.config.baseURL,
    apiKey: request.config.apiKey,
  });
  const result = await generateText({
    model: provider(request.config.model),
    system: request.system,
    prompt: `Suggest one label from this sanitized context:\n${JSON.stringify(request.context)}`,
    maxOutputTokens: request.maxOutputTokens,
    ...(request.config.reasoningEffort
      ? {
          providerOptions: {
            openaiCompatible: {
              reasoningEffort: request.config.reasoningEffort,
            },
          },
        }
      : {}),
    maxRetries: request.maxRetries,
    abortSignal: request.abortSignal,
  });
  return result.text;
}

export class AiSdkNamer implements Namer {
  readonly #env: NodeJS.ProcessEnv;
  readonly #complete: Complete;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    complete: Complete = completeWithAiSdk,
  ) {
    this.#env = env;
    this.#complete = complete;
  }

  async suggest(context: NamingContext): Promise<NameSuggestion> {
    const config = await loadProviderConfig(this.#env);
    try {
      const text = await this.#complete({
        config,
        context,
        system: NAMING_SYSTEM_PROMPT,
        maxOutputTokens: 32_768,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(config.timeoutMs),
      });
      return parseSuggestion(text);
    } catch (error) {
      throw new Error(
        `AI request failed (${config.provider}/${config.model}): ${safeProviderError(error, config)}`,
      );
    }
  }
}
