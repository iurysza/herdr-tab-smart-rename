import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { sanitizeText } from "./text.ts";

const CommandsSchema = z.object({
  keys: z.object({ command: z.array(z.unknown()) }),
});

const PluginActionSchema = z.object({
  type: z.literal("plugin_action"),
  command: z.string(),
});

export type KeybindingAction = "rename-now" | "rename-all";

export type KeybindingStatus = "already-configured" | "available" | "colliding" | "uncertain";

export interface KeybindingInstruction {
  readonly action: KeybindingAction;
  readonly label: string;
  readonly toml: string;
}

export const KEYBINDING_INSTRUCTIONS: readonly KeybindingInstruction[] = [
  {
    action: "rename-now",
    label: "Rename the current tab",
    toml: "[[keys.command]]\nkey = \"prefix+t\"\ntype = \"plugin_action\"\ncommand = \"tab-smart-rename.rename-now\"\ndescription = \"smart rename current tab\"",
  },
  {
    action: "rename-all",
    label: "Rename all tabs",
    toml: "[[keys.command]]\nkey = \"prefix+alt+t\"\ntype = \"plugin_action\"\ncommand = \"tab-smart-rename.rename-all\"\ndescription = \"force smart rename all tabs\"",
  },
];

export interface KeybindingResult {
  readonly action: KeybindingAction;
  readonly status: KeybindingStatus;
  readonly instruction: KeybindingInstruction;
  readonly diagnostic?: string;
}

export interface KeybindingInspection {
  readonly path?: string;
  readonly results: readonly KeybindingResult[];
  readonly uncertainty?: string;
  readonly remoteAttachNote: string;
}

export interface KeybindingDependencies {
  readonly run?: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readonly read?: typeof readFile;
  readonly exists?: (file: string) => Promise<boolean>;
  readonly temporaryDirectory?: (prefix: string) => Promise<string>;
  readonly write?: typeof writeFile;
  readonly remove?: typeof rm;
}

export function resolveHerdrConfigPath(
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (env.HERDR_CONFIG_PATH) return env.HERDR_CONFIG_PATH;
  const root = env.XDG_CONFIG_HOME || (env.HOME ? path.join(env.HOME, ".config") : undefined);

  return root ? path.join(root, "herdr", "config.toml") : undefined;
}

export async function inspectKeybindings(
  requested: readonly KeybindingAction[],
  env: NodeJS.ProcessEnv = process.env,
  {
    run = defaultRun,
    read = readFile,
    exists = fileExists,
    temporaryDirectory = (prefix) => mkdtemp(path.join(os.tmpdir(), prefix)),
    write = writeFile,
    remove = rm,
  }: KeybindingDependencies = {},
): Promise<KeybindingInspection> {
  const instructions = KEYBINDING_INSTRUCTIONS.filter((instruction) =>
    requested.includes(instruction.action),
  );

  const remoteAttachNote = "For remote attaches, keybindings normally belong to the attaching client. This server-side setup cannot inspect that client configuration.";
  const configPath = resolveHerdrConfigPath(env);

  if (!configPath || !(await exists(configPath))) {
    return uncertain(instructions, "The local Herdr config path is unavailable; no binding or collision status was checked.", remoteAttachNote);
  }

  const originalCheck = await checkConfig(configPath, env, run);

  if (originalCheck.exitCode !== 0) {
    return uncertain(instructions, `The local Herdr config is invalid: ${diagnostic(originalCheck)}.`, remoteAttachNote, configPath);
  }

  let original: string;
  let existing: Set<string>;

  try {
    original = await read(configPath, "utf8");
    const parsed = CommandsSchema.safeParse(Bun.TOML.parse(original));

    existing = parsed.success
      ? new Set(parsed.data.keys.command.flatMap((item) => {
          const action = PluginActionSchema.safeParse(item);

          return action.success ? [action.data.command] : [];
        }))
      : new Set();
  } catch {
    return uncertain(instructions, "The local Herdr config could not be read or parsed; no binding or collision status was checked.", remoteAttachNote, configPath);
  }

  const results: KeybindingResult[] = [];

  for (const instruction of instructions) {
    if (existing.has(`tab-smart-rename.${instruction.action}`)) {
      results.push({ action: instruction.action, status: "already-configured", instruction });
      continue;
    }

    const candidate = `${original.trimEnd()}\n\n${instruction.toml}\n`;
    const checked = await checkCandidate(candidate, env, run, temporaryDirectory, write, remove);

    const result: KeybindingResult = checked.exitCode === 0
      ? { action: instruction.action, status: "available", instruction }
      : { action: instruction.action, status: "colliding", instruction, diagnostic: diagnostic(checked) };

    results.push(result);
  }

  return { path: configPath, results, remoteAttachNote };
}

async function checkCandidate(
  content: string,
  env: NodeJS.ProcessEnv,
  run: NonNullable<KeybindingDependencies["run"]>,
  temporaryDirectory: NonNullable<KeybindingDependencies["temporaryDirectory"]>,
  write: NonNullable<KeybindingDependencies["write"]>,
  remove: NonNullable<KeybindingDependencies["remove"]>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const directory = await temporaryDirectory("smart-rename-keybindings-");
  const candidate = path.join(directory, "config.toml");

  try {
    await chmod(directory, 0o700);
    await write(candidate, content, { mode: 0o600 });
    await chmod(candidate, 0o600);

    return await checkConfig(candidate, env, run);
  } finally {
    await remove(directory, { recursive: true, force: true });
  }
}

async function checkConfig(
  configPath: string,
  env: NodeJS.ProcessEnv,
  run: NonNullable<KeybindingDependencies["run"]>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return run(env.HERDR_BIN_PATH || "herdr", ["config", "check"], {
    ...env,
    HERDR_CONFIG_PATH: configPath,
  });
}

function uncertain(
  instructions: readonly KeybindingInstruction[],
  message: string,
  remoteAttachNote: string,
  configPath?: string,
): KeybindingInspection {
  const inspection: KeybindingInspection = {
    results: instructions.map((instruction) => ({
      action: instruction.action,
      status: "uncertain",
      instruction,
    })),
    uncertainty: message,
    remoteAttachNote,
  };

  return configPath ? { ...inspection, path: configPath } : inspection;
}

function diagnostic(result: { stdout: string; stderr: string }): string {
  return sanitizeText(result.stderr || result.stdout).trim() || "Herdr config check failed";
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);

    return true;
  } catch {
    return false;
  }
}

async function defaultRun(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([command, ...args], { env, stdout: "pipe", stderr: "pipe" });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exitCode, stdout, stderr };
}
