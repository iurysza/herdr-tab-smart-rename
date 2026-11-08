import os from "node:os";
import path from "node:path";

export function nativeHome(env: NodeJS.ProcessEnv): string {
  const home = env.HOME || os.homedir();

  if (!path.isAbsolute(home)) throw new Error("Native HOME must be an absolute directory");

  return home;
}

export function nativeConfigDirectory(env: NodeJS.ProcessEnv, override?: string): string {
  const directory = override ?? env.HERDR_PLUGIN_CONFIG_DIR ?? path.join(
    env.XDG_CONFIG_HOME ?? path.join(nativeHome(env), ".config"), "herdr-tab-smart-rename", "native",
  );

  if (!path.isAbsolute(directory)) throw new Error("Native config directory must be absolute");

  return directory;
}
