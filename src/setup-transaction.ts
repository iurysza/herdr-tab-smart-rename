import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { modelSelectionPath } from "./model-selection.ts";
import { providerEnvPath } from "./provider.ts";

interface FileSnapshot {
  readonly path: string;
  readonly exists: boolean;
  readonly bytes?: Uint8Array;
  readonly mode?: number;
}

interface DirectorySnapshot {
  readonly path: string;
  readonly exists: boolean;
  readonly mode?: number;
}

export interface SetupTransaction {
  readonly configDirectory: string;
  rollback(): Promise<void>;
  commit(): void;
}

export async function beginSetupTransaction(
  configDirectory: string,
  { includesDirect = false }: { readonly includesDirect?: boolean } = {},
): Promise<SetupTransaction> {
  const paths = [
    modelSelectionPath(configDirectory),
    ...(includesDirect ? [providerEnvPath({ HERDR_PLUGIN_CONFIG_DIR: configDirectory })] : []),
  ].filter((value): value is string => Boolean(value));
  const [directory, files] = await Promise.all([
    snapshotDirectory(configDirectory),
    Promise.all(paths.map(snapshotFile)),
  ]);
  let committed = false;
  return {
    configDirectory,
    commit: () => {
      committed = true;
    },
    rollback: async () => {
      if (committed) return;
      const failures: string[] = [];
      for (const file of files) {
        try {
          await restoreFile(file);
        } catch {
          failures.push(file.path);
        }
      }
      try {
        await restoreDirectory(directory);
      } catch {
        failures.push(directory.path);
      }
      if (failures.length) {
        throw new Error(`Could not roll back Smart Rename setup files: ${failures.join(", ")}`);
      }
    },
  };
}

async function snapshotFile(file: string): Promise<FileSnapshot> {
  try {
    const [bytes, details] = await Promise.all([readFile(file), stat(file)]);
    return { path: file, exists: true, bytes, mode: details.mode & 0o777 };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { path: file, exists: false };
    throw error;
  }
}

async function snapshotDirectory(directory: string): Promise<DirectorySnapshot> {
  try {
    const details = await stat(directory);
    return { path: directory, exists: true, mode: details.mode & 0o777 };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { path: directory, exists: false };
    throw error;
  }
}

async function restoreFile(snapshot: FileSnapshot): Promise<void> {
  if (!snapshot.exists) {
    await rm(snapshot.path, { force: true });
    return;
  }
  await mkdir(path.dirname(snapshot.path), { recursive: true, mode: 0o700 });
  const temporary = `${snapshot.path}.${process.pid}.${randomUUID()}.rollback.tmp`;
  try {
    await writeFile(temporary, snapshot.bytes!, { mode: snapshot.mode! });
    await chmod(temporary, snapshot.mode!);
    await rename(temporary, snapshot.path);
    await chmod(snapshot.path, snapshot.mode!);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function restoreDirectory(snapshot: DirectorySnapshot): Promise<void> {
  if (snapshot.exists) {
    await mkdir(snapshot.path, { recursive: true, mode: snapshot.mode! });
    await chmod(snapshot.path, snapshot.mode!);
    return;
  }
  await rmdir(snapshot.path).catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT") throw error;
  });
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}
