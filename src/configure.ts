#!/usr/bin/env bun
import path from "node:path";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import {
  bundledNamingPrompt,
  configuredNamingPromptPath,
  providerEnvPath,
  providerExampleText,
  readOpencodeConfig,
} from "./provider.ts";
import { parse as parseEnv } from "dotenv";

async function ensureConfigDirectory(env: NodeJS.ProcessEnv): Promise<string> {
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

export async function importOpenCodeConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const opencode = await readOpencodeConfig();
  if (!opencode) {
    throw new Error(
      "No OpenCode config found at ~/.config/opencode/opencode.json or .jsonc",
    );
  }

  const configDir = env.HERDR_PLUGIN_CONFIG_DIR;
  if (!configDir) throw new Error("HERDR_PLUGIN_CONFIG_DIR is required");
  await ensureConfigDirectory(env);
  const envFile = providerEnvPath(env);
  if (!envFile) throw new Error("HERDR_PLUGIN_CONFIG_DIR is required");

  const existing = await readFile(envFile, "utf8").catch(() => "");
  const parsed = parseEnv(existing);

  parsed.SMART_RENAME_PROVIDER = opencode.provider;
  parsed.SMART_RENAME_BASE_URL = opencode.baseURL;
  parsed.SMART_RENAME_MODEL = opencode.model;
  parsed.SMART_RENAME_API_KEY = opencode.apiKey;

  const lines: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    lines.push(`${k}=${v}`);
  }
  await writeFile(envFile, lines.join("\n") + "\n", { mode: 0o600 });
  await chmod(envFile, 0o600);

  console.log(
    `Imported OpenCode config → ${envFile} (${opencode.provider}/${opencode.model})`,
  );
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
