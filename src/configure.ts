#!/usr/bin/env bun
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { providerEnvPath } from "./provider.ts";

export const PROVIDER_ENV_TEMPLATE = `# Smart Rename AI provider
# Kimi Code defaults need only this key:
SMART_RENAME_API_KEY=

# Optional OpenAI-compatible provider overrides:
# SMART_RENAME_PROVIDER=kimi-code
# SMART_RENAME_BASE_URL=https://api.kimi.com/coding/v1
# SMART_RENAME_MODEL=kimi-for-coding
# SMART_RENAME_REASONING_EFFORT=medium
# SMART_RENAME_TIMEOUT_MS=45000
`;

export async function ensureProviderFile(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const directory = env.HERDR_PLUGIN_CONFIG_DIR;
  if (!directory) throw new Error("HERDR_PLUGIN_CONFIG_DIR is required");

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const file = providerEnvPath(env);
  if (!file) throw new Error("HERDR_PLUGIN_CONFIG_DIR is required");
  try {
    await writeFile(file, PROVIDER_ENV_TEMPLATE, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  await chmod(file, 0o600);
  return file;
}

export async function configureProvider(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const file = await ensureProviderFile(env);
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

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

if (import.meta.main) {
  configureProvider().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Smart Rename: ${message}`);
    process.exitCode = 1;
  });
}
