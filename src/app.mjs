import { AiSdkNamer } from "./provider.mjs";
import { AutoNameService, statePaths } from "./service.mjs";

/**
 * Compose the Smart Rename service used by CLI actions and the worker.
 *
 * @param {{
 *   stateDir?: string | null,
 *   env?: NodeJS.ProcessEnv,
 *   dryRun?: boolean,
 *   namer?: import("./service.mjs").Namer,
 *   dependencies?: Partial<import("./service.mjs").ServiceDependencies>,
 * }} options
 */
export function createService({
  stateDir = null,
  env = process.env,
  dryRun = false,
  namer = new AiSdkNamer(env),
  dependencies = {},
} = {}) {
  const paths = stateDir ? statePaths(stateDir) : null;
  return new AutoNameService({
    stateFile: paths?.state ?? null,
    stateLock: paths?.stateLock ?? null,
    namer,
    env,
    dryRun,
    dependencies,
  });
}
