import path from "node:path";
import { z } from "zod";
import { nativeConfigDirectory, nativeHome } from "./native-config.ts";

export const NATIVE_SERVICE_LABEL = "dev.herdr.tab-smart-rename.native";

export const NATIVE_READY_TIMEOUT_MS = 180_000;

// Match the existing app/core command tripwire, including status and rollback.
export const NATIVE_LAUNCHCTL_TIMEOUT_MS = 10_000;

export class NativeInstallError extends Error {}

export interface NativeInstallPaths {
  dataRoot: string;
  runtimeDir: string;
  configDir: string;
  activation: string;
  current: string;
  wrapper: string;
  plist: string;
  lock: string;
}

export function nativeInstallPaths(env: NodeJS.ProcessEnv, configDir?: string): NativeInstallPaths {
  const home = nativeHome(env);
  const dataRoot = path.join(env.XDG_DATA_HOME ?? path.join(home, ".local/share"), "herdr-tab-smart-rename", "native");
  const runtimeDir = path.join(env.XDG_STATE_HOME ?? path.join(home, ".local/state"), "herdr-tab-smart-rename", "native-service");

  if (!path.isAbsolute(dataRoot) || !path.isAbsolute(runtimeDir))
    throw new NativeInstallError("Native data and state roots must be absolute");

  return {
    dataRoot, runtimeDir, configDir: nativeConfigDirectory(env, configDir),
    activation: path.join(dataRoot, "activation.json"),
    current: path.join(dataRoot, "current"),
    wrapper: path.join(home, ".local/bin/smart-rename-native"),
    plist: path.join(home, "Library/LaunchAgents", `${NATIVE_SERVICE_LABEL}.plist`),
    lock: path.join(dataRoot, "install.lock"),
  };
}

// Deliberately excludes provider keys, model overrides and inherited daemon IDs.
export const NATIVE_ENV_KEYS = [
  "HOME", "PATH", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "HERDR_APP_BIN_PATH", "HC_BIN_PATH", "HERDR_APP_HOME", "HC_SESSION", "PI_CODING_AGENT_DIR", "HERDR_PLUGIN_ROOT",
] as const;

const EnvironmentSchema = z.partialRecord(z.enum(NATIVE_ENV_KEYS), z.string());

export const NativeActivationSchema = z.object({
  version: z.literal(1),
  owner: z.literal("herdr-tab-smart-rename/native-service"),
  sourceRoot: z.string(),
  configDir: z.string(),
  runtimeDir: z.string(),
  env: EnvironmentSchema,
}).strict();

export type NativeActivation = z.infer<typeof NativeActivationSchema>;

export function validateActivation(value: unknown, paths: NativeInstallPaths): NativeActivation {
  const parsed = NativeActivationSchema.safeParse(value);

  if (!parsed.success) throw new NativeInstallError("Native activation metadata is invalid; refusing to replace it");
  const activation = parsed.data;
  const parent = path.join(paths.dataRoot, "versions");

  if (path.dirname(activation.sourceRoot) !== parent || !/^[a-f\d]{40}$/.test(path.basename(activation.sourceRoot)) ||
      !path.isAbsolute(activation.configDir) || !path.isAbsolute(activation.runtimeDir))
    throw new NativeInstallError("Native activation paths are invalid; refusing to replace them");

  return activation;
}

function xml(value: string): string {
  for (const character of value) {
    const code = character.charCodeAt(0);

    if (code < 32 && ![9, 10, 13].includes(code)) throw new NativeInstallError("Native service values contain invalid control characters");
  }

  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function renderNativePlist(activation: NativeActivation): string {
  const args = [path.join(activation.sourceRoot, "src/run-bun.sh"), path.join(activation.sourceRoot, "src/native-worker.ts"),
    "--config-dir", activation.configDir, "--runtime-dir", activation.runtimeDir];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${NATIVE_SERVICE_LABEL}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(activation.sourceRoot)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>EnvironmentVariables</key><dict>${Object.entries(activation.env).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("")}</dict>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function renderNativeWrapper(activation: NativeActivation, paths: NativeInstallPaths): string {
  const env = Object.entries(activation.env).map(([key, value]) => shellQuote(`${key}=${value}`));

  return `#!/bin/sh
# herdr-tab-smart-rename native wrapper v1
set -eu
exec /usr/bin/env -i ${env.join(" ")} ${shellQuote(path.join(paths.current, "src/run-bun.sh"))} ${shellQuote(path.join(paths.current, "src/native-install.ts"))} --config-dir ${shellQuote(activation.configDir)} "$@"
`;
}

export type NativeServiceProcess =
  | { state: "absent" }
  | { state: "loaded"; pid: number | null; plist: string; program: string }
  | { state: "unknown" };

export interface NativeServiceController {
  inspect(): Promise<NativeServiceProcess>;
  bootstrap(plist: string): Promise<void>;
  bootout(): Promise<void>;
}

export type LaunchctlCommand = (args: string[]) => Promise<{ stdout: string; exitCode: number }>;

export function createNativeServiceController(
  env: NodeJS.ProcessEnv,
  uid: number,
  command: LaunchctlCommand = async (args) => {
    const child = Bun.spawn(["/bin/launchctl", ...args], {
      env: { HOME: nativeHome(env), PATH: "/usr/bin:/bin" }, stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, NATIVE_LAUNCHCTL_TIMEOUT_MS);

    try {
      const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);

      if (timedOut) throw new NativeInstallError(`Native launchctl exceeded NATIVE_LAUNCHCTL_TIMEOUT_MS=${NATIVE_LAUNCHCTL_TIMEOUT_MS}ms`);

      return { stdout, exitCode };
    } finally { clearTimeout(timer); }
  },
): NativeServiceController {
  const domain = `gui/${uid}`;
  const target = `${domain}/${NATIVE_SERVICE_LABEL}`;

  return {
    inspect: async () => {
      const result = await command(["print", target]);

      if (result.exitCode === 113) return { state: "absent" };

      if (result.exitCode !== 0) return { state: "unknown" };
      const plist = /^\s*path = (.+)$/m.exec(result.stdout)?.[1];
      const program = /^\s*program = (.+)$/m.exec(result.stdout)?.[1];
      const pid = /^\s*pid = (\d+)$/m.exec(result.stdout)?.[1];

      if (!plist || !program) return { state: "unknown" };

      return { state: "loaded", plist: plist.trim(), program: program.trim(), pid: pid ? Number(pid) : null };
    },
    bootstrap: async (plist) => {
      const result = await command(["bootstrap", domain, plist]);

      if (result.exitCode !== 0) throw new NativeInstallError("Native LaunchAgent bootstrap failed");
    },
    bootout: async () => {
      const result = await command(["bootout", target]);

      if (result.exitCode !== 0 && result.exitCode !== 113) throw new NativeInstallError("Native LaunchAgent bootout failed");
    },
  };
}
