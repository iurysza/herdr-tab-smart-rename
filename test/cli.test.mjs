import test from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../src/cli.mjs";

test("CLI dispatch routes actions without running at import time", async () => {
  const calls = [];
  const actions = {
    status: (options) => calls.push(["status", options]),
    once: (options) => calls.push(["once", options]),
  };

  await dispatch("status", { actions });
  await dispatch("once", { actions, dryRun: true });

  assert.deepEqual(calls, [
    ["status", { dryRun: false }],
    ["once", { dryRun: true }],
  ]);
  await assert.rejects(dispatch("unknown", { actions }), /^Error: usage:/);
});
