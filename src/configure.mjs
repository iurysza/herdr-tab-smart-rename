#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { providerEnvPath } from "./provider.mjs";

export const PROVIDER_ENV_TEMPLATE = `# Smart Rename AI provider
# Kimi Code defaults need only this key:
SMART_RENAME_API_KEY=

# Optional OpenAI-compatible provider overrides:
# SMART_RENAME_PROVIDER=kimi-code
# SMART_RENAME_BASE_URL=https://api.kimi.com/coding/v1
# SMART_RENAME_MODEL=kimi-for-coding
# SMART_RENAME_TIMEOUT_MS=45000
`;

export async function ensureProviderFile(env = process.env) {
  const directory = env.HERDR_PLUGIN_CONFIG_DIR;
  if (!directory) {
    throw new Error("HERDR_PLUGIN_CONFIG_DIR is required");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const file = providerEnvPath(env);
  try {
    await writeFile(file, PROVIDER_ENV_TEMPLATE, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await chmod(file, 0o600);
  return file;
}

export async function configureProvider(env = process.env) {
  const file = await ensureProviderFile(env);
  const editor = env.VISUAL || env.EDITOR || "vi";
  await new Promise((resolve, reject) => {
    const child = spawn(editor, [file], { env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`editor exited ${code ?? signal}`));
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  configureProvider().catch((error) => {
    console.error(`Smart Rename: ${error.message}`);
    process.exitCode = 1;
  });
}
