import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireLock, pidAlive, workerInfo } from "../src/singleton.mjs";

test("PID helper rejects invalid and dead processes", () => {
  assert.equal(pidAlive(42, () => {}), true);
  assert.equal(pidAlive(42, () => { throw new Error("gone"); }), false);
  assert.equal(pidAlive(1, () => {}), false);
});

test("stale lock owners are recovered", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autoname-lock-"));
  const lock = path.join(dir, "state.lock");
  await writeFile(lock, '{"pid":99999999,"nonce":"old"}\n');
  try {
    const release = await acquireLock(lock, { timeoutMs: 500 });
    await release();
    await assert.rejects(access(lock));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker verification requires the exact absolute script", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autoname-pid-"));
  const file = path.join(dir, "worker.json");
  const expected = "/repo/herdr-autoname/src/worker.mjs";
  const dependencies = {
    isAlive: () => true,
    commandForPid: async () => `node ${expected}`,
  };
  try {
    await writeFile(
      file,
      `${JSON.stringify({ pid: 42, script: expected, startedAt: "now" })}\n`,
    );
    assert.equal((await workerInfo(file, expected, dependencies)).pid, 42);

    await writeFile(
      file,
      `${JSON.stringify({ pid: 42, script: "/other/src/worker.mjs" })}\n`,
    );
    assert.equal(await workerInfo(file, expected, dependencies), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
