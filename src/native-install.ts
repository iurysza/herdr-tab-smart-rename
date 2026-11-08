#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { nativeConfigDirectory, nativeHome } from "./native-config.ts";
import { loadModelSelection, modelSelectionPath } from "./model-selection.ts";
import { loadNamingPrompt, loadProviderConfig, NAMING_PROMPT_NAME, providerEnvPath } from "./provider.ts";
import { runNativeSetup, type SetupResult } from "./setup.ts";
import { beginSetupTransaction } from "./setup-transaction.ts";
import { acquireLock } from "./storage.ts";
import { sanitizeText } from "./text.ts";
import { installTrigger, uninstallTrigger, type TriggerResult } from "./native-trigger.ts";
import {
  createNativeServiceController, nativeInstallPaths, NativeInstallError, NATIVE_ENV_KEYS, NATIVE_READY_TIMEOUT_MS,
  renderNativePlist, renderNativeWrapper, validateActivation,
  type NativeActivation, type NativeInstallPaths, type NativeServiceController, type NativeServiceProcess,
} from "./native-service.ts";

const HealthSchema = z.object({
  version: z.literal(1), pid: z.number().int().positive(),
  state: z.enum(["starting", "ready", "waiting", "stopping", "failed"]),
  managedTabs: z.number().int().nonnegative(), updatedAt: z.iso.datetime(),
  targets: z.object({ active: z.number().int().nonnegative(), waiting: z.number().int().nonnegative(), blocked: z.number().int().nonnegative() }).optional(),
  lastError: z.object({
    targetId: z.string().transform((value) => sanitizeText(value)),
    reason: z.string().transform((value) => sanitizeText(value).slice(0, 200)),
    timestamp: z.iso.datetime(),
  }).optional(),
});

type NativeHealth = z.infer<typeof HealthSchema>;

const NATIVE_CONFIG_FILES = ["model-selection.json", "naming-prompt.md", "provider.env"] as const;

type NativeConfigFile = typeof NATIVE_CONFIG_FILES[number];

export interface NativeInstallResult {
  installed: boolean;
  service: "running" | "loaded" | "absent" | "unknown";
  configDir?: string;
  health?: NativeHealth;
  cancelled?: boolean;
  imported?: NativeConfigFile[];
  /** The in-app key and mod (herdr-app's keys.json and mods/smart-rename). */
  trigger?: TriggerResult;
}

export interface NativeInstallOptions {
  env?: NodeJS.ProcessEnv;
  configDir?: string;
  sourceRoot?: string;
}

export interface NativeInstallDependencies {
  controller?: NativeServiceController;
  setup?: (env: NodeJS.ProcessEnv) => Promise<SetupResult>;
  hasConfiguration?: (env: NodeJS.ProcessEnv) => Promise<boolean>;
  platform?: NodeJS.Platform;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  readyTimeoutMs?: number;
}

type FileSnapshot = { bytes: Buffer; mode: number } | null;

type InstallationSnapshot = {
  activationFile: FileSnapshot;
  plist: FileSnapshot;
  wrapper: FileSnapshot;
  current: string | null;
  activation: NativeActivation | null;
};

async function snapshotFile(file: string): Promise<FileSnapshot> {
  try {
    const details = await lstat(file);

    if (!details.isFile() || details.isSymbolicLink()) throw new NativeInstallError("Refusing to replace a non-regular native installation file");

    return { bytes: await readFile(file), mode: details.mode & 0o777 };
  } catch (error) {
    if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success) return null;
    throw error;
  }
}

async function currentTarget(file: string): Promise<string | null> {
  try {
    const details = await lstat(file);

    if (!details.isSymbolicLink()) throw new NativeInstallError("Refusing to replace an unowned native current pointer");

    return readlink(file);
  } catch (error) {
    if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success) return null;
    throw error;
  }
}

async function ownedSnapshot(paths: NativeInstallPaths): Promise<InstallationSnapshot> {
  const [activationFile, plist, wrapper, current] = await Promise.all([
    snapshotFile(paths.activation), snapshotFile(paths.plist), snapshotFile(paths.wrapper), currentTarget(paths.current),
  ]);

  let activation: NativeActivation | null = null;

  if (activationFile) {
    let value: unknown;

    try { value = JSON.parse(activationFile.bytes.toString("utf8")); }
    catch { throw new NativeInstallError("Native activation metadata is invalid; refusing to replace it"); }

    activation = validateActivation(value, paths);
  }

  if (!activation && (plist || wrapper || current)) throw new NativeInstallError("Native installation files exist without ownership metadata; refusing to replace them");

  if (activation && (
    (plist && plist.bytes.toString("utf8") !== renderNativePlist(activation)) ||
    (wrapper && wrapper.bytes.toString("utf8") !== renderNativeWrapper(activation, paths)) ||
    (current && current !== activation.sourceRoot)
  )) throw new NativeInstallError("Native installation files were changed or belong to another owner; refusing to replace them");

  return { activationFile, plist, wrapper, current, activation };
}

function assertServiceOwned(process: NativeServiceProcess, activation: NativeActivation | null, paths: NativeInstallPaths): void {
  if (process.state === "unknown") throw new NativeInstallError("Cannot determine native LaunchAgent ownership");

  if (process.state === "loaded" && (!activation || process.plist !== paths.plist || process.program !== path.join(activation.sourceRoot, "src/run-bun.sh")))
    throw new NativeInstallError("Native service label belongs to an unrelated LaunchAgent; refusing to change it");
}

async function writeAtomic(file: string, bytes: string | Buffer, mode: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporary, bytes, { mode, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function pointCurrent(file: string, target: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await symlink(target, temporary);
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

async function restore(paths: NativeInstallPaths, snapshot: InstallationSnapshot): Promise<void> {
  for (const [file, previous] of [[paths.plist, snapshot.plist], [paths.wrapper, snapshot.wrapper], [paths.activation, snapshot.activationFile]] as const) {
    if (previous) await writeAtomic(file, previous.bytes, previous.mode);
    else await rm(file, { force: true });
  }

  if (snapshot.current) await pointCurrent(paths.current, snapshot.current);
  else await rm(paths.current, { force: true });
}

async function readHealth(runtimeDir: string): Promise<NativeHealth | undefined> {
  try { return HealthSchema.parse(JSON.parse(await readFile(path.join(runtimeDir, "status.json"), "utf8"))); }
  catch { return undefined; }
}

async function hasNativeConfiguration(env: NodeJS.ProcessEnv): Promise<boolean> {
  const directory = nativeConfigDirectory(env);

  try {
    const selectionFile = await snapshotFile(modelSelectionPath(directory));
    const providerFile = await snapshotFile(providerEnvPath(env)!);

    if (!selectionFile && !providerFile) return false;
    const selection = await loadModelSelection(directory, env);

    if (selection.source === "direct") await loadProviderConfig(env);
    await loadNamingPrompt(env);

    return true;
  } catch { return false; }
}

async function importDaemonConfiguration(env: NodeJS.ProcessEnv): Promise<NativeConfigFile[]> {
  const destination = nativeConfigDirectory(env);
  const conventional = path.join(env.XDG_CONFIG_HOME ?? path.join(nativeHome(env), ".config"), "herdr/plugins/config/tab-smart-rename");
  let source: string;

  try { source = await realpath(conventional); } catch (error) {
    if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success) return [];
    throw error;
  }

  // An explicit override may already point at the daemon directory. Importing
  // must never rewrite that source or change its permissions.
  let resolvedDestination = destination;

  try { resolvedDestination = await realpath(destination); } catch (error) {
    if (!z.object({ code: z.literal("ENOENT") }).safeParse(error).success) throw error;
  }

  if (source === resolvedDestination || !(await lstat(source)).isDirectory()) return [];
  const files = await Promise.all(NATIVE_CONFIG_FILES.map(async (name) => ({ name, snapshot: await snapshotFile(path.join(source, name)) })));
  const imported: NativeConfigFile[] = [];

  for (const file of files) {
    if (!file.snapshot) continue;
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await chmod(destination, 0o700);
    await writeAtomic(path.join(destination, file.name), file.snapshot.bytes, 0o600);
    imported.push(file.name);
  }

  return imported;
}

async function executable(program: string, env: NodeJS.ProcessEnv): Promise<string> {
  const found = path.isAbsolute(program) ? program : Bun.which(program, { PATH: env.PATH ?? "/usr/bin:/bin" });

  if (!found) throw new NativeInstallError("Native app/core executable not found; set HERDR_APP_BIN_PATH and HC_BIN_PATH to absolute executables");
  await access(found, constants.X_OK).catch(() => {
    throw new NativeInstallError("Native app/core executable is not executable");
  });

  return path.resolve(found);
}

async function activationFor(sourceRoot: string, configDir: string, paths: NativeInstallPaths, env: NodeJS.ProcessEnv): Promise<NativeActivation> {
  if (path.dirname(sourceRoot) !== path.join(paths.dataRoot, "versions") || !/^[a-f\d]{40}$/.test(path.basename(sourceRoot)))
    throw new NativeInstallError("Native install requires a persistent versions/<40-character commit> payload");
  const source = await lstat(sourceRoot);
  const versions = await lstat(path.dirname(sourceRoot));

  if (!source.isDirectory() || source.isSymbolicLink() || !versions.isDirectory() || versions.isSymbolicLink() || await realpath(sourceRoot) !== sourceRoot)
    throw new NativeInstallError("Native payload must be a canonical version directory, not a symlink");
  await access(path.join(sourceRoot, "src/run-bun.sh"), constants.X_OK);
  await access(path.join(sourceRoot, "src/native-worker.ts"), constants.R_OK);
  await access(path.join(sourceRoot, "src/native-install.ts"), constants.R_OK);
  const serviceEnv: NativeActivation["env"] = {};

  for (const key of NATIVE_ENV_KEYS) {
    if (env[key] !== undefined) serviceEnv[key] = env[key];
  }

  serviceEnv.HOME = nativeHome(env);
  serviceEnv.PATH = [path.dirname(process.execPath), env.PATH ?? "/usr/bin:/bin", "/opt/homebrew/bin", "/usr/local/bin"].join(":");
  serviceEnv.HERDR_APP_BIN_PATH = await executable(env.HERDR_APP_BIN_PATH || "herdr-app", env);
  serviceEnv.HC_BIN_PATH = await executable(env.HC_BIN_PATH || "hc", env);
  serviceEnv.HERDR_APP_HOME = env.HERDR_APP_HOME ?? path.join(nativeHome(env), ".config/herdr-app");
  serviceEnv.HERDR_PLUGIN_ROOT = sourceRoot;

  return { version: 1, owner: "herdr-tab-smart-rename/native-service", sourceRoot, configDir, runtimeDir: paths.runtimeDir, env: serviceEnv };
}

async function waitReady(
  controller: NativeServiceController, activation: NativeActivation, paths: NativeInstallPaths,
  startedAt: number, dependencies: NativeInstallDependencies,
): Promise<NativeHealth> {
  const now = dependencies.now ?? Date.now;
  const timeout = dependencies.readyTimeoutMs ?? NATIVE_READY_TIMEOUT_MS;
  const sleep = dependencies.sleep ?? Bun.sleep;

  for (;;) {
    const process = await controller.inspect();
    assertServiceOwned(process, activation, paths);
    const health = await readHealth(activation.runtimeDir);

    if (process.state === "loaded" && process.pid && health?.pid === process.pid && Date.parse(health.updatedAt) >= startedAt) {
      if (health.state === "ready") return health;

      if (health.state === "failed") throw new NativeInstallError("Native worker reported failed during startup");
    }

    if (now() - startedAt >= timeout)
      throw new NativeInstallError(`Native readiness exceeded NATIVE_READY_TIMEOUT_MS=${timeout}ms; previous activation will be restored`);
    await sleep(100);
  }
}

async function status(paths: NativeInstallPaths, controller: NativeServiceController): Promise<NativeInstallResult> {
  const snapshot = await ownedSnapshot(paths);
  const process = await controller.inspect();

  if (process.state !== "unknown") assertServiceOwned(process, snapshot.activation, paths);

  const result: NativeInstallResult = {
    installed: snapshot.activation !== null,
    service: process.state === "loaded" ? process.pid ? "running" : "loaded" : process.state,
  };

  if (snapshot.activation) {
    result.configDir = snapshot.activation.configDir;
    const health = await readHealth(snapshot.activation.runtimeDir);

    if (process.state === "loaded" && process.pid === health?.pid) result.health = health;
  }

  return result;
}

async function rollbackService(
  paths: NativeInstallPaths, snapshot: InstallationSnapshot, previous: NativeServiceProcess,
  controller: NativeServiceController, attempted: NativeActivation | null,
  restoreConfiguration: () => Promise<void> = async () => {},
): Promise<void> {
  const current = await controller.inspect();

  if (attempted) {
    assertServiceOwned(current, attempted, paths);

    if (current.state === "loaded") await controller.bootout();
  } else assertServiceOwned(current, snapshot.activation, paths);
  await restore(paths, snapshot);
  // A prior worker must never restart against a failed setup's temporary keys.
  await restoreConfiguration();

  if (previous.state === "loaded" && snapshot.activation) {
    const restored = await controller.inspect();
    assertServiceOwned(restored, snapshot.activation, paths);

    if (restored.state === "absent") await controller.bootstrap(paths.plist);
  }
}

export async function nativeInstall(
  action: "install" | "status" | "uninstall", options: NativeInstallOptions = {}, dependencies: NativeInstallDependencies = {},
): Promise<NativeInstallResult> {
  if ((dependencies.platform ?? process.platform) !== "darwin") throw new NativeInstallError("Native service installation requires macOS");
  const env = options.env ?? process.env;
  const paths = nativeInstallPaths(env, options.configDir);
  const controller = dependencies.controller ?? createNativeServiceController(env, process.getuid!());

  if (action === "status") return status(paths, controller);
  await mkdir(paths.dataRoot, { recursive: true, mode: 0o700 });
  const data = await lstat(paths.dataRoot);

  if (!data.isDirectory() || data.isSymbolicLink()) throw new NativeInstallError("Native data root must be an owned directory, not a symlink");
  const release = await acquireLock(paths.lock, { timeoutMs: 0 });

  try {
    const snapshot = await ownedSnapshot(paths);
    const previous = await controller.inspect();
    assertServiceOwned(previous, snapshot.activation, paths);

    if (action === "uninstall") {
      try {
        if (previous.state === "loaded") await controller.bootout();
        await rm(paths.plist, { force: true });
        await rm(paths.wrapper, { force: true });
        await rm(paths.current, { force: true });
        await rm(paths.activation, { force: true });
      } catch {
        await rollbackService(paths, snapshot, previous, controller, null).catch(() => {
          throw new NativeInstallError("Native uninstall failed and rollback was incomplete");
        });
        throw new NativeInstallError("Native uninstall failed; previous activation restored");
      }

      const appHome = snapshot.activation?.env.HERDR_APP_HOME ?? env.HERDR_APP_HOME ?? path.join(nativeHome(env), ".config/herdr-app");

      return { installed: false, service: "absent", trigger: await uninstallTrigger(appHome, { now: dependencies.now }) };
    }

    const configDir = nativeConfigDirectory(env, options.configDir ?? env.HERDR_PLUGIN_CONFIG_DIR ?? snapshot.activation?.configDir);
    const sourceRoot = options.sourceRoot ?? path.resolve(import.meta.dir, "..");
    const activation = await activationFor(sourceRoot, configDir, paths, env);
    const setupEnv = { ...activation.env, HERDR_PLUGIN_CONFIG_DIR: configDir };

    // Setup rollback snapshots regular files, not symlink identities. Refuse
    // redirects before allowing the wizard to write or change permissions.
    try {
      const config = await lstat(configDir);

      if (!config.isDirectory() || config.isSymbolicLink()) throw new NativeInstallError("Native config root must not be a symlink or non-directory");
    } catch (error) {
      if (!z.object({ code: z.literal("ENOENT") }).safeParse(error).success) throw error;
    }

    await snapshotFile(modelSelectionPath(configDir));
    await snapshotFile(providerEnvPath(setupEnv)!);
    const promptFile = path.join(configDir, NAMING_PROMPT_NAME);
    const promptSnapshot = await snapshotFile(promptFile);
    const configTransaction = await beginSetupTransaction(configDir, { includesDirect: true });
    let attempted: NativeActivation | null = null;
    let configurationRestored = false;

    const restoreConfiguration = async () => {
      // Remove an imported prompt before the existing transaction restores an
      // originally absent config directory. It owns the selection/provider files.
      if (promptSnapshot) await writeAtomic(promptFile, promptSnapshot.bytes, promptSnapshot.mode);
      else await rm(promptFile, { force: true });
      await configTransaction.rollback();
      configurationRestored = true;
    };

    try {
      const hasConfiguration = dependencies.hasConfiguration ?? hasNativeConfiguration;
      let configured = await hasConfiguration(setupEnv);
      let imported: NativeConfigFile[] = [];

      if (!configured) {
        imported = await importDaemonConfiguration(setupEnv);

        if (imported.length) configured = await hasConfiguration(setupEnv);
      }

      if (!configured) {
        const setup = await (dependencies.setup ?? runNativeSetup)(setupEnv);

        if (!setup.selection) {
          await restoreConfiguration();

          return { installed: snapshot.activation !== null, service: previous.state === "loaded" ? previous.pid ? "running" : "loaded" : "absent", cancelled: true };
        }
      }

      if (previous.state === "loaded") await controller.bootout();
      await chmod(paths.dataRoot, 0o700);
      await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
      const runtime = await lstat(paths.runtimeDir);

      if (!runtime.isDirectory() || runtime.isSymbolicLink()) throw new NativeInstallError("Native runtime root must not be a symlink");
      await pointCurrent(paths.current, sourceRoot);
      await writeAtomic(paths.wrapper, renderNativeWrapper(activation, paths), 0o755);
      await writeAtomic(paths.plist, renderNativePlist(activation), 0o600);
      const startedAt = (dependencies.now ?? Date.now)();
      attempted = activation;
      await controller.bootstrap(paths.plist);
      const health = await waitReady(controller, activation, paths, startedAt, dependencies);
      await writeAtomic(paths.activation, `${JSON.stringify(activation, null, 2)}\n`, 0o600);
      configTransaction.commit();
      // The key reaches the service through the payload the activation points at, so it comes last.
      const trigger = await installTrigger(activation.env.HERDR_APP_HOME!, activation, paths, { now: dependencies.now });

      const result: NativeInstallResult = { installed: true, service: "running", configDir, health, trigger };

      if (imported.length) result.imported = imported;

      return result;
    } catch (error) {
      let rolledBack = true;

      try { await rollbackService(paths, snapshot, previous, controller, attempted, restoreConfiguration); } catch { rolledBack = false; }

      if (!configurationRestored) {
        try { await restoreConfiguration(); } catch { rolledBack = false; }
      }

      if (!rolledBack) throw new NativeInstallError("Native installation failed and rollback was incomplete; inspect the owned service before retrying");

      if (error instanceof NativeInstallError) throw error;
      throw new NativeInstallError("Native installation failed; previous activation and configuration restored");
    }
  } finally { await release(); }
}

export interface NativeInstallArguments {
  action: "install" | "status" | "uninstall";
  configDir?: string;
}

export function nativeInstallOptions(args: string[]): NativeInstallArguments {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { "config-dir": { type: "string" } } });
  const action = z.enum(["install", "status", "uninstall"]).safeParse(positionals[0]);

  if (!action.success || positionals.length !== 1 || (values["config-dir"] !== undefined && !path.isAbsolute(values["config-dir"])))
    throw new NativeInstallError("usage: native-install.ts install|status|uninstall [--config-dir ABSOLUTE_DIRECTORY]");
  const result: NativeInstallArguments = { action: action.data };

  if (values["config-dir"] !== undefined) result.configDir = values["config-dir"];

  return result;
}

export async function nativeInstallMain(args: string[], options: NativeInstallOptions = {}, dependencies: NativeInstallDependencies = {}): Promise<NativeInstallResult> {
  const parsed = nativeInstallOptions(args);
  const requested = { ...options };

  if (parsed.configDir) requested.configDir = parsed.configDir;

  return nativeInstall(parsed.action, requested, dependencies);
}

if (import.meta.main) {
  await nativeInstallMain(process.argv.slice(2)).then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error: Error) => {
    console.error(error instanceof NativeInstallError ? error.message : "Native service command failed");
    process.exitCode = 1;
  });
}
