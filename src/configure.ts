#!/usr/bin/env bun
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseEnv } from "dotenv";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import {
  bundledNamingPrompt,
  configuredNamingPromptPath,
  providerEnvPath,
  providerExampleText,
} from "./provider.ts";

export interface DirectSetupConfig {
  provider: string;
  baseURL: string;
  model: string;
  apiKey: string;
  reasoningEffort?: "low" | "medium" | "high" | undefined;
  timeoutMs: number;
}

export function validateDirectSetupConfig(config: DirectSetupConfig): void {
  for (const value of [config.provider, config.baseURL, config.model, config.apiKey]) {
    if (!value || /[\r\n\0]/.test(value)) throw new Error("Direct setup values must be non-empty single-line text");
  }
  let endpoint: URL;
  try { endpoint = new URL(config.baseURL); }
  catch { throw new Error("Direct base URL must be a valid HTTP or HTTPS URL"); }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error("Direct base URL must be an HTTP or HTTPS URL without credentials");
  }
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1_000 || config.timeoutMs > 300_000) {
    throw new Error("Direct timeout must be between 1000 and 300000 ms");
  }
}

export async function saveDirectProviderConfig(config: DirectSetupConfig, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  validateDirectSetupConfig(config);
  await ensureConfigDirectory(env);
  const file = providerEnvPath(env)!;
  const entries = {
    SMART_RENAME_PROVIDER: config.provider,
    SMART_RENAME_BASE_URL: config.baseURL,
    SMART_RENAME_MODEL: config.model,
    SMART_RENAME_API_KEY: config.apiKey,
    SMART_RENAME_REASONING_EFFORT: config.reasoningEffort ?? "",
    SMART_RENAME_TIMEOUT_MS: String(config.timeoutMs),
  };
  const content = Object.entries(entries).map(([key, value]) => {
    const encoded = [`'${value}'`, `"${value}"`, `\`${value}\``, value]
      .find((candidate) => parseEnv(`${key}=${candidate}`)[key] === value);
    if (encoded === undefined) throw new Error(`Cannot encode ${key} in provider.env`);
    return `${key}=${encoded}`;
  }).join("\n") + "\n";
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function ensureConfigDirectory(env: NodeJS.ProcessEnv): Promise<string> {
  const directory = env.HERDR_PLUGIN_CONFIG_DIR;
  if (!directory) throw new Error("HERDR_PLUGIN_CONFIG_DIR is required");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return directory;
}

async function createPrivateFile(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  await chmod(file, 0o600);
}

export async function ensureProviderFile(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  await ensureConfigDirectory(env);
  const file = providerEnvPath(env);
  if (!file) throw new Error("HERDR_PLUGIN_CONFIG_DIR is required");
  await createPrivateFile(file, await providerExampleText());
  return file;
}

export async function ensureNamingPromptFile(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  await ensureConfigDirectory(env);
  const file = await configuredNamingPromptPath(env);
  await createPrivateFile(file, `${await bundledNamingPrompt()}\n`);
  return file;
}

async function openEditor(file: string, env: NodeJS.ProcessEnv): Promise<void> {
  const editor = env.VISUAL || env.EDITOR || "vi";
  const child = Bun.spawn([editor, file], {
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`editor exited ${exitCode}`);
}

export async function configureProvider(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await openEditor(await ensureProviderFile(env), env);
}

export async function configurePrompt(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await openEditor(await ensureNamingPromptFile(env), env);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

if (import.meta.main) {
  const command = process.argv[2] || "provider";
  const configure = command === "prompt" ? configurePrompt : configureProvider;
  configure().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Smart Rename: ${message}`);
    process.exitCode = 1;
  });
}
