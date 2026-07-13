import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, open, readFile, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function pidAlive(pid, signal = process.kill) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    signal(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function commandForPid(pid) {
  const { stdout } = await execFileAsync(
    "ps",
    ["-p", String(pid), "-o", "command="],
    { timeout: 2_000 },
  );
  return stdout.trim();
}

export async function workerInfo(pidFile, expectedScript, dependencies = {}) {
  let info;
  try {
    info = JSON.parse(await readFile(pidFile, "utf8"));
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

async function staleLock(lockFile, staleMs) {
  let age = Infinity;
  try {
    age = Date.now() - (await stat(lockFile)).mtimeMs;
  } catch {
    return true;
  }
  try {
    const owner = JSON.parse(await readFile(lockFile, "utf8"));
    if (age >= staleMs) return true;
    if (pidAlive(owner.pid)) return false;
    return true;
  } catch {
    return age >= staleMs;
  }
}

export async function acquireLock(
  lockFile,
  { timeoutMs = 130_000, staleMs = 5 * 60_000, retryMs = 50 } = {},
) {
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
          const owner = JSON.parse(await readFile(lockFile, "utf8"));
          if (owner.nonce === nonce) await rm(lockFile, { force: true });
        } catch {
          // A stale/replaced lock is not ours to remove.
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await staleLock(lockFile, staleMs)) {
        await rm(lockFile, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for lock: ${lockFile}`);
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}
