import { test } from "bun:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dispatch } from "../src/cli.ts";
import { acquireLock, pidAlive, workerInfo } from "../src/storage.ts";

test("CLI dispatch routes actions without executing on import", async () => {
  const calls: Array<[string, { dryRun: boolean }]> = [];
  const actions = {
    status: (options: { dryRun: boolean }) => calls.push(["status", options]),
    once: (options: { dryRun: boolean }) => calls.push(["once", options]),
  };
  await dispatch("status", { actions });
  await dispatch("once", { actions, dryRun: true });
  assert.deepEqual(calls, [
    ["status", { dryRun: false }],
    ["once", { dryRun: true }],
  ]);
  await assert.rejects(dispatch("unknown", { actions }), /^Error: usage:/);
});

test("locks recover dead owners and workers require exact Bun scripts", async () => {
  assert.equal(pidAlive(42, () => true), true);
  assert.equal(
    pidAlive(42, () => {
      throw new Error("gone");
    }),
    false,
  );
  assert.equal(pidAlive(1, () => true), false);

  const dir = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-runtime-"));
  const lock = path.join(dir, "state.lock");
  const pidFile = path.join(dir, "worker.json");
  const expected = "/repo/herdr-tab-smart-rename/src/worker.ts";
  try {
    await writeFile(lock, '{"pid":99999999,"nonce":"old"}\n');
    const release = await acquireLock(lock, { timeoutMs: 500 });
    await release();
    await assert.rejects(access(lock));

    await writeFile(
      pidFile,
      `${JSON.stringify({ pid: 42, script: expected, startedAt: "now" })}\n`,
    );
    const dependencies = {
      isAlive: () => true,
      commandForPid: async () => `bun ${expected}`,
    };
    assert.equal((await workerInfo(pidFile, expected, dependencies))?.pid, 42);
    assert.equal(
      await workerInfo(pidFile, "/other/src/worker.ts", dependencies),
      null,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
