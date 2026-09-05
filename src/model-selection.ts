import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  MODEL_SOURCE_IDS,
  type ModelSelection,
} from "./model-source.ts";

export const MODEL_SELECTION_NAME = "model-selection.json";

const SelectionValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((value) => !/[\r\n]/.test(value), "must be a single line");

export const ModelSelectionSchema: z.ZodType<ModelSelection> = z
  .object({
    version: z.literal(1),
    source: z.enum(MODEL_SOURCE_IDS),
    provider: SelectionValueSchema,
    model: SelectionValueSchema,
    profile: SelectionValueSchema.optional(),
  })
  .strict();

const DEFAULT_DIRECT_SELECTION: ModelSelection = {
  version: 1,
  source: "direct",
  provider: "direct",
  model: "direct",
};

export function modelSelectionPath(configDir: string): string {
  return path.join(configDir, MODEL_SELECTION_NAME);
}

export function parseModelSelection(value: unknown): ModelSelection {
  const parsed = ModelSelectionSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("model-selection.json is invalid; run setup");
  }
  return parsed.data;
}

function environmentSelection(
  selection: ModelSelection,
  env: NodeJS.ProcessEnv,
): ModelSelection {
  const source =
    env.SMART_RENAME_MODEL_SOURCE ?? env.SMART_RENAME_SOURCE ?? selection.source;
  const profile = env.SMART_RENAME_PROFILE ?? selection.profile;
  if (source === "direct" && selection.provider === "direct" && selection.model === "direct") {
    return DEFAULT_DIRECT_SELECTION;
  }
  return parseModelSelection({
    version: 1,
    source,
    provider: env.SMART_RENAME_PROVIDER ?? selection.provider,
    model: env.SMART_RENAME_MODEL ?? selection.model,
    ...(profile ? { profile } : {}),
  });
}

export async function loadModelSelection(
  configDir: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ModelSelection> {
  if (!configDir) return environmentSelection(DEFAULT_DIRECT_SELECTION, env);
  try {
    const selection = parseModelSelection(
      JSON.parse(await readFile(modelSelectionPath(configDir), "utf8")),
    );
    return environmentSelection(selection, env);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return environmentSelection(DEFAULT_DIRECT_SELECTION, env);
    }
    throw error;
  }
}

export interface WriteSelectionDependencies {
  mkdir: typeof mkdir;
  chmod: typeof chmod;
  writeFile: typeof writeFile;
  rename: typeof rename;
  rm: typeof rm;
}

const fileDependencies: WriteSelectionDependencies = {
  mkdir,
  chmod,
  writeFile,
  rename,
  rm,
};

export async function saveModelSelection(
  configDir: string,
  selection: ModelSelection,
  dependencies: WriteSelectionDependencies = fileDependencies,
): Promise<void> {
  const validated = parseModelSelection(selection);
  await dependencies.mkdir(configDir, { recursive: true, mode: 0o700 });
  await dependencies.chmod(configDir, 0o700);
  const file = modelSelectionPath(configDir);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await dependencies.writeFile(
      temporary,
      `${JSON.stringify(validated, null, 2)}\n`,
      { mode: 0o600 },
    );
    await dependencies.chmod(temporary, 0o600);
    await dependencies.rename(temporary, file);
    await dependencies.chmod(file, 0o600);
  } catch (error) {
    await dependencies.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function resolvePluginConfigDirectory(
  env: NodeJS.ProcessEnv = process.env,
  run: (
    command: string,
    args: string[],
  ) => Promise<{ stdout: string; exitCode: number }> = runConfigDirectoryCommand,
): Promise<string> {
  if (env.HERDR_PLUGIN_CONFIG_DIR) return env.HERDR_PLUGIN_CONFIG_DIR;
  const result = await run(env.HERDR_BIN_PATH || "herdr", [
    "plugin",
    "config-dir",
    "tab-smart-rename",
  ]);
  const directory = result.stdout.trim();
  if (result.exitCode !== 0 || !directory) {
    throw new Error("Could not resolve the Smart Rename config directory");
  }
  return directory;
}

async function runConfigDirectoryCommand(
  command: string,
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const child = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "ignore",
    env: process.env,
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return { stdout, exitCode };
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}
