import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  emptyState,
  type SmartRenameState,
} from "./domain.ts";

const OwnershipRecordSchema = z.object({
  manual: z.boolean().optional(),
  autoLabel: z.string().optional(),
  expectedLabel: z.string().optional(),
  observedLabel: z.string().optional(),
});

const StateSchema: z.ZodType<SmartRenameState> = z.looseObject({
  version: z.literal(1),
  workspaces: z.record(z.string(), OwnershipRecordSchema),
  tabs: z.record(z.string(), OwnershipRecordSchema),
  modelAttempts: z.record(z.string(), z.number()),
  fingerprints: z.record(z.string(), z.string()),
  pendingFingerprints: z.record(z.string(), z.string()),
});

const UnknownRecordSchema = z.record(z.string(), z.unknown());

const WorkerInfoSchema = z.object({
  pid: z.number().int().positive(),
  script: z.string().min(1),
  startedAt: z.string().min(1),
});

const LockOwnerSchema = z.object({
  pid: z.number().int().positive(),
  nonce: z.string().min(1),
  createdAt: z.number().optional(),
});

export type WorkerInfo = z.infer<typeof WorkerInfoSchema>;

export interface StatePaths {
  state: string;
  pid: string;
  startLock: string;
  stateLock: string;
  log: string;
}

export function statePaths(stateDir: string): StatePaths {
  return {
    state: path.join(stateDir, "state.json"),
    pid: path.join(stateDir, "worker.json"),
    startLock: path.join(stateDir, "start.lock"),
    stateLock: path.join(stateDir, "state.lock"),
    log: path.join(stateDir, "worker.log"),
  };
}

export async function ensurePrivateDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

export async function loadState(
  file: string | null | undefined,
): Promise<SmartRenameState> {
  if (!file) return emptyState();
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return StateSchema.parse({ ...emptyState(), ...asRecord(value) });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return emptyState();
    throw error;
  }
}

export async function saveState(
  file: string,
  state: SmartRenameState,
): Promise<void> {
  const validated = StateSchema.parse(state);
  await ensurePrivateDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, file);
  await chmod(file, 0o600);
}

export async function withStateTransaction<T>(
  stateFile: string,
  lockFile: string,
  operation: (
    state: SmartRenameState,
    persist: () => Promise<void>,
  ) => Promise<T> | T,
): Promise<T> {
  const release = await acquireLock(lockFile);
  try {
    const state = await loadState(stateFile);
    const persist = () => saveState(stateFile, state);
    const result = await operation(state, persist);
    await persist();
    return result;
  } finally {
    await release();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  const parsed = UnknownRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

export function pidAlive(
  pid: number,
  signal: typeof process.kill = process.kill,
): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    signal(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function commandForPid(pid: number): Promise<string> {
  const process = Bun.spawn(["ps", "-p", String(pid), "-o", "command="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [command, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`ps exited ${exitCode}`);
  return command.trim();
}

interface WorkerDependencies {
  isAlive?: (pid: number) => boolean;
  commandForPid?: (pid: number) => Promise<string>;
}

export async function removeOwnedWorkerPid(
  pidFile: string,
  pid: number,
): Promise<void> {
  try {
    const info = WorkerInfoSchema.parse(JSON.parse(await readFile(pidFile, "utf8")));
    if (info.pid === pid) await rm(pidFile, { force: true });
  } catch {
    // The owner may already have removed a stale PID file.
  }
}

export async function workerInfo(
  pidFile: string,
  expectedScript: string,
  dependencies: WorkerDependencies = {},
): Promise<WorkerInfo | null> {
  let info: WorkerInfo;
  try {
    info = WorkerInfoSchema.parse(JSON.parse(await readFile(pidFile, "utf8")));
  } catch {
    return null;
  }

  const isAlive = dependencies.isAlive ?? pidAlive;
  const getCommand = dependencies.commandForPid ?? commandForPid;
  if (!isAlive(info.pid) || info.script !== expectedScript) {
    await rm(pidFile, { force: true });
    return null;
  }
  try {
    const command = await getCommand(info.pid);
    if (!command.includes(expectedScript)) {
      await rm(pidFile, { force: true });
      return null;
    }
  } catch {
    await rm(pidFile, { force: true });
    return null;
  }
  return info;
}

async function staleLock(lockFile: string, staleMs: number): Promise<boolean> {
  let age = Infinity;
  try {
    age = Date.now() - (await stat(lockFile)).mtimeMs;
  } catch {
    return true;
  }
  try {
    const owner = LockOwnerSchema.parse(JSON.parse(await readFile(lockFile, "utf8")));
    return age >= staleMs || !pidAlive(owner.pid);
  } catch {
    return age >= staleMs;
  }
}

interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
}

export async function acquireLock(
  lockFile: string,
  { timeoutMs = 130_000, staleMs = 5 * 60_000, retryMs = 50 }: LockOptions = {},
): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs;
  const nonce = randomUUID();
  while (true) {
    try {
      const handle = await open(lockFile, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, nonce, createdAt: Date.now() })}\n`,
      );
      await handle.close();
      await chmod(lockFile, 0o600);
      return async () => {
        try {
          const owner = LockOwnerSchema.parse(
            JSON.parse(await readFile(lockFile, "utf8")),
          );
          if (owner.nonce === nonce) await rm(lockFile, { force: true });
        } catch {
          // A stale or replaced lock is not ours to remove.
        }
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (await staleLock(lockFile, staleMs)) {
        await rm(lockFile, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for lock: ${lockFile}`);
      }
      await Bun.sleep(retryMs);
    }
  }
}
