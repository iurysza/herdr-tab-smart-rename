import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { parse as parseEnv } from "dotenv";
import { z } from "zod";
import {
  type NameSuggestion,
  type NamingContext,
  validateTabLabel,
} from "./domain.ts";
import { sanitizeText } from "./text.ts";

const PROVIDER_ENV_BYTES = 16 * 1024;
const NAMING_PROMPT_BYTES = 32 * 1024;
const PROVIDER_EXAMPLE_URL = new URL("../provider.env.example", import.meta.url);
const BUNDLED_NAMING_PROMPT = fileURLToPath(
  new URL("../docs/naming-policy.md", import.meta.url),
);
export const PROVIDER_ENV_NAME = "provider.env";
export const NAMING_PROMPT_NAME = "naming-prompt.md";

const HttpBaseUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  });

const ProviderConfigSchema = z
  .object({
    provider: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    baseURL: z.string().optional(),
    model: z.string().min(1).refine((value) => !/[\r\n]/.test(value)),
    timeoutMs: z.number().int().min(1_000).max(300_000),
    reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
    promptPath: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
  })
  .superRefine((config, context) => {
    if (config.provider === "omp") return;
    if (!config.baseURL || !HttpBaseUrlSchema.safeParse(config.baseURL).success) {
      context.addIssue({
        code: "custom",
        path: ["baseURL"],
        message: "SMART_RENAME_BASE_URL must be an HTTP(S) URL without credentials",
      });
    }
    if (!config.apiKey) {
      context.addIssue({
        code: "custom",
        path: ["apiKey"],
        message: "AI key missing",
      });
    }
  })
  .transform((config) =>
    config.baseURL
      ? { ...config, baseURL: config.baseURL.replace(/\/$/, "") }
      : config,
  );

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

async function readBoundedText(
  source: string | URL,
  label: string,
  maxBytes: number,
  required = false,
): Promise<string | null> {
  const file = Bun.file(source);
  if (!(await file.exists())) {
    if (required) throw new Error(`${label} is missing`);
    return null;
  }
  if (file.size > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes / 1024} KiB`);
  }
  return file.text();
}

async function readProviderEnv(
  filePath: string | URL | null,
  required = false,
): Promise<Record<string, string>> {
  if (!filePath) return {};
  const text = await readBoundedText(
    filePath,
    filePath === PROVIDER_EXAMPLE_URL ? "provider.env.example" : PROVIDER_ENV_NAME,
    PROVIDER_ENV_BYTES,
    required,
  );
  return text === null ? {} : parseEnv(text);
}

export async function providerExampleText(): Promise<string> {
  return (
    (await readBoundedText(
      PROVIDER_EXAMPLE_URL,
      "provider.env.example",
      PROVIDER_ENV_BYTES,
      true,
    )) || ""
  );
}

export async function bundledNamingPrompt(): Promise<string> {
  return readNamingPrompt(BUNDLED_NAMING_PROMPT, true);
}

function pick(
  processEnv: NodeJS.ProcessEnv,
  fileEnv: Record<string, string>,
  defaults: Record<string, string>,
  name: string,
): string {
  return processEnv[name] || fileEnv[name] || defaults[name] || "";
}

function resolvePromptPath(value: string, env: NodeJS.ProcessEnv): string {
  if (path.isAbsolute(value)) return value;
  return path.resolve(env.HERDR_PLUGIN_CONFIG_DIR || process.cwd(), value);
}

function providerApiKey(
  provider: string,
  processEnv: NodeJS.ProcessEnv,
  fileEnv: Record<string, string>,
): string {
  const providerKey =
    provider === "openai"
      ? "OPENAI_API_KEY"
      : provider === "kimi-code"
        ? "KIMI_API_KEY"
        : null;
  return (
    processEnv.SMART_RENAME_API_KEY ||
    fileEnv.SMART_RENAME_API_KEY ||
    (providerKey ? processEnv[providerKey] || fileEnv[providerKey] : "") ||
    ""
  );
}

export async function configuredNamingPromptPath(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const fileEnv = await readProviderEnv(providerEnvPath(env));
  const configured = env.SMART_RENAME_PROMPT_PATH || fileEnv.SMART_RENAME_PROMPT_PATH;
  if (configured) return resolvePromptPath(configured, env);
  return env.HERDR_PLUGIN_CONFIG_DIR
    ? path.join(env.HERDR_PLUGIN_CONFIG_DIR, NAMING_PROMPT_NAME)
    : BUNDLED_NAMING_PROMPT;
}

async function readNamingPrompt(filePath: string, required = false): Promise<string> {
  const text = await readBoundedText(
    filePath,
    path.basename(filePath),
    NAMING_PROMPT_BYTES,
    required,
  );
  const prompt = text?.trim();
  if (!prompt) throw new Error(`${path.basename(filePath)} is empty`);
  return prompt;
}

function configError(error: z.ZodError): Error {
  const field = error.issues[0]?.path[0];
  const messages: Record<PropertyKey, string> = {
    provider: "SMART_RENAME_PROVIDER is invalid",
    baseURL: "SMART_RENAME_BASE_URL must be an HTTP(S) URL without credentials",
    model: "SMART_RENAME_MODEL is required",
    timeoutMs: "SMART_RENAME_TIMEOUT_MS must be 1000-300000",
    reasoningEffort: "SMART_RENAME_REASONING_EFFORT must be low, medium, or high",
    promptPath: "SMART_RENAME_PROMPT_PATH is invalid",
    apiKey: `AI key missing. Run configure-ai or set a provider key in ${PROVIDER_ENV_NAME}`,
  };
  return new Error(messages[field ?? ""] ?? "AI provider configuration is invalid");
}

export async function loadProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderConfig> {
  const [defaults, fileEnv] = await Promise.all([
    readProviderEnv(PROVIDER_EXAMPLE_URL, true),
    readProviderEnv(providerEnvPath(env)),
  ]);
  const provider = pick(env, fileEnv, defaults, "SMART_RENAME_PROVIDER");
  const configuredReasoning =
    env.SMART_RENAME_REASONING_EFFORT || fileEnv.SMART_RENAME_REASONING_EFFORT;
  const reasoningEffort =
    configuredReasoning ||
    (provider === defaults.SMART_RENAME_PROVIDER
      ? defaults.SMART_RENAME_REASONING_EFFORT
      : "");
  const baseURL = pick(
    env,
    fileEnv,
    provider === "omp" ? {} : defaults,
    "SMART_RENAME_BASE_URL",
  );
  const apiKey = providerApiKey(provider, env, fileEnv);
  const configuredPrompt =
    env.SMART_RENAME_PROMPT_PATH || fileEnv.SMART_RENAME_PROMPT_PATH;
  const input = {
    provider,
    ...(baseURL ? { baseURL } : {}),
    model: pick(env, fileEnv, defaults, "SMART_RENAME_MODEL"),
    timeoutMs: Number(pick(env, fileEnv, defaults, "SMART_RENAME_TIMEOUT_MS")),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(configuredPrompt
      ? { promptPath: resolvePromptPath(configuredPrompt, env) }
      : {}),
    ...(apiKey ? { apiKey } : {}),
  };
  const parsed = ProviderConfigSchema.safeParse(input);
  if (!parsed.success) throw configError(parsed.error);
  return parsed.data;
}

export async function loadNamingPrompt(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (config.promptPath) return readNamingPrompt(config.promptPath, true);

  if (env.HERDR_PLUGIN_CONFIG_DIR) {
    const privatePrompt = path.join(env.HERDR_PLUGIN_CONFIG_DIR, NAMING_PROMPT_NAME);
    const text = await readBoundedText(
      privatePrompt,
      NAMING_PROMPT_NAME,
      NAMING_PROMPT_BYTES,
    );
    if (text !== null) {
      const prompt = text.trim();
      if (!prompt) throw new Error(`${NAMING_PROMPT_NAME} is empty`);
      return prompt;
    }
  }

  return bundledNamingPrompt();
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
  if (config.apiKey) message = message.replaceAll(config.apiKey, "[redacted]");
  return sanitizeText(message).slice(0, 400) || "provider request failed";
}

export interface CompletionRequest {
  config: ProviderConfig;
  context: NamingContext;
  system: string;
  maxOutputTokens: 32_768;
  maxRetries: 1;
  env: NodeJS.ProcessEnv;
  abortSignal: AbortSignal;
}

type Complete = (request: CompletionRequest) => Promise<string>;

export function transformOpenAiRequestBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const { max_tokens, ...rest } = body;
  return max_tokens == null
    ? rest
    : { ...rest, max_completion_tokens: max_tokens };
}

async function completeWithAiSdk(request: CompletionRequest): Promise<string> {
  const { baseURL, apiKey } = request.config;
  if (!baseURL || !apiKey) throw new Error("provider configuration is incomplete");
  const provider = createOpenAICompatible({
    name: request.config.provider,
    baseURL,
    apiKey,
    ...(request.config.provider === "openai"
      ? {
          transformRequestBody: transformOpenAiRequestBody,
        }
      : {}),
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

const OMP_OUTPUT_BYTES = 2 * 1024 * 1024;
const OMP_CLEANUP_GRACE_MS = 250;

async function readBoundedOutput(
  stream: ReadableStream<Uint8Array>,
  label: string,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > OMP_OUTPUT_BYTES) {
        throw new Error(`${label} output exceeded buffer`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function drainOmpOutput(
  output: Promise<[string, string]>,
  abortPromise: Promise<never>,
): Promise<[string, string]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("omp output drain timed out")),
      OMP_CLEANUP_GRACE_MS,
    );
  });
  try {
    return await Promise.race([output, abortPromise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function completeWithOmp(request: CompletionRequest): Promise<string> {
  const args = [
    "omp",
    "-p",
    "--model",
    request.config.model,
    "--no-session",
    "--no-tools",
    "--no-lsp",
    "--no-extensions",
    "--no-skills",
    "--no-rules",
  ];
  if (request.config.reasoningEffort) {
    args.push("--thinking", request.config.reasoningEffort);
  }
  const child = Bun.spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...request.env },
    windowsHide: true,
  });
  const prompt = `${request.system}\n\nSuggest one label from this sanitized context:\n${JSON.stringify(request.context)}\n`;
  const stdoutPromise = readBoundedOutput(child.stdout, "omp stdout");
  const stderrPromise = readBoundedOutput(child.stderr, "omp stderr");
  const outputPromise = Promise.all([stdoutPromise, stderrPromise]);
  void outputPromise.catch(() => {});
  const stdinPromise = (async () => {
    await child.stdin.write(prompt);
    await child.stdin.end();
  })();
  let rejectAbort: (reason?: unknown) => void = () => {};
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const kill = () => {
    try {
      child.kill();
    } catch {
      // The process may have exited between output and cleanup.
    }
  };
  const onAbort = () => {
    kill();
    rejectAbort(new Error("omp request aborted"));
  };
  request.abortSignal.addEventListener("abort", onAbort, { once: true });
  if (request.abortSignal.aborted) onAbort();
  try {
    await Promise.race([stdinPromise, abortPromise]);
    const exitCode = await Promise.race([child.exited, abortPromise]);
    if (request.abortSignal.aborted) throw new Error("omp request aborted");
    let output: [string, string];
    try {
      output = await drainOmpOutput(outputPromise, abortPromise);
    } catch (error) {
      if (exitCode !== 0 && !request.abortSignal.aborted) {
        throw new Error(`omp exit ${exitCode}`);
      }
      throw error;
    }
    if (request.abortSignal.aborted) throw new Error("omp request aborted");
    if (exitCode !== 0) {
      throw new Error(`omp exit ${exitCode}`);
    }
    return output[0];
  } catch (error) {
    kill();
    await Promise.race([
      Promise.allSettled([child.exited, stdinPromise, stdoutPromise, stderrPromise]),
      new Promise<void>((resolve) => setTimeout(resolve, OMP_CLEANUP_GRACE_MS)),
    ]);
    throw error;
  } finally {
    request.abortSignal.removeEventListener("abort", onAbort);
  }
}

async function completeWithProvider(request: CompletionRequest): Promise<string> {
  return request.config.provider === "omp"
    ? completeWithOmp(request)
    : completeWithAiSdk(request);
}

export class AiSdkNamer implements Namer {
  readonly #env: NodeJS.ProcessEnv;
  readonly #complete: Complete;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    complete: Complete = completeWithProvider,
  ) {
    this.#env = env;
    this.#complete = complete;
  }

  async suggest(context: NamingContext): Promise<NameSuggestion> {
    const config = await loadProviderConfig(this.#env);
    const system = await loadNamingPrompt(config, this.#env);
    try {
      const text = await this.#complete({
        config,
        context,
        system,
        maxOutputTokens: 32_768,
        maxRetries: 1,
        env: this.#env,
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
