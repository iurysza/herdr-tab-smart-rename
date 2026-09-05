import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  HERDR_PLUGIN_LOG_LIMIT,
  HerdrPluginClient,
  type CommandResult,
  type CommandRunner,
} from "../src/herdr-plugin-client.ts";

const result = (stdout: unknown, exitCode = 0, stderr = ""): CommandResult => ({
  exitCode,
  stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
  stderr,
});

const runningServer = {
  status: "running",
  running: true,
  compatible: true,
  version: "0.7.0",
  socket: "/tmp/herdr.sock",
};

function runnerFor(
  responses: CommandResult[],
  calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }>,
): CommandRunner {
  return async (command, args, env) => {
    calls.push({ command, args, env });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected command: ${args.join(" ")}`);
    return next;
  };
}

test("preflights the target server and preserves target environment", async () => {
  const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const env = { HERDR_BIN_PATH: "/opt/herdr", HERDR_SOCKET_PATH: "/tmp/target.sock" };
  const client = new HerdrPluginClient({
    env,
    run: runnerFor([result(runningServer)], calls),
  });
  assert.deepEqual(await client.preflightServer(), { socket: "/tmp/herdr.sock" });
  assert.deepEqual(calls[0], {
    command: "/opt/herdr",
    args: ["status", "server", "--json"],
    env,
  });
});

test("rejects absent, incompatible, malformed, and failed server preflight boundaries", async () => {
  for (const response of [
    result({ running: false }),
    result({ running: true, compatible: false, version: "0.6.0" }),
    result("not-json"),
    result({}, 1, "no server"),
  ]) {
    const client = new HerdrPluginClient({ run: async () => response });
    await assert.rejects(client.preflightServer());
  }
});

test("finds a managed plugin, reports missing plugin, and rejects missing root", async () => {
  const plugin = {
    result: {
      plugins: [
        {
          plugin_id: "tab-smart-rename",
          plugin_root: "/managed/root",
          source: { kind: "github", owner: "iurysza", repo: "herdr-tab-smart-rename", requested_ref: "v0.2.0", resolved_commit: "abc" },
        },
      ],
    },
  };
  const found = new HerdrPluginClient({ run: async () => result(plugin) });
  assert.deepEqual(await found.installedPlugin(), {
    id: "tab-smart-rename",
    root: "/managed/root",
    source: { kind: "github", owner: "iurysza", repo: "herdr-tab-smart-rename", ref: "v0.2.0" },
    commit: "abc",
  });

  const missing = new HerdrPluginClient({ run: async () => result({ result: { plugins: [] } }) });
  assert.equal(await missing.installedPlugin(), null);

  const noRoot = new HerdrPluginClient({
    run: async () => result({ result: { plugins: [{ plugin_id: "tab-smart-rename" }] } }),
  });
  await assert.rejects(noRoot.installedPlugin(), /managed root/);
});

test("resolves the config directory and invokes an action with its exact log id", async () => {
  const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const client = new HerdrPluginClient({
    run: runnerFor([
      result("/private/config\n"),
      result({ result: { log: { log_id: "log-42" } } }),
    ], calls),
  });
  assert.equal(await client.configDirectory(), "/private/config");
  assert.equal(await client.invoke("start"), "log-42");
  assert.deepEqual(calls.map((call) => call.args), [
    ["plugin", "config-dir", "tab-smart-rename"],
    ["plugin", "action", "invoke", "start", "--plugin", "tab-smart-rename"],
  ]);
});

test("waits only for the invoked action log and accepts succeeded exit zero", async () => {
  let now = 0;
  const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const client = new HerdrPluginClient({
    now: () => now,
    sleep: async () => { now += 10; },
    run: runnerFor([
      result({ result: { logs: [{ log_id: "newer", status: "succeeded", exit_code: 0 }, { log_id: "wanted", status: "running" }] } }),
      result({ result: { logs: [{ log_id: "wanted", status: "succeeded", exit_code: 0 }] } }),
    ], calls),
  });
  await client.waitForAction("start", "wanted");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.args, [
      "plugin", "log", "list", "--plugin", "tab-smart-rename", "--limit", String(HERDR_PLUGIN_LOG_LIMIT),
    ]);
  }
});

test("reports terminal failures with sanitized matching output", async () => {
  const client = new HerdrPluginClient({
    run: async () => result({
      result: { logs: [{ log_id: "wanted", status: "failed", exit_code: 1, stderr: "token sk-12345678901234567890 failed" }] },
    }),
  });
  await assert.rejects(client.waitForAction("start", "wanted"), (error: unknown) => {
    assert.match(String(error), /start action log wanted failed/);
    assert.doesNotMatch(String(error), /sk-12345678901234567890/);
    return true;
  });
});

test("names every action timeout diagnostic", async () => {
  let now = 0;
  const client = new HerdrPluginClient({
    now: () => now,
    actionTimeoutMs: 20,
    sleep: async () => { now += 10; },
    run: async () => result({ result: { logs: [] } }),
  });
  await assert.rejects(client.waitForAction("start", "gone"), (error: unknown) => {
    const message = String(error);
    assert.match(message, /action=start/);
    assert.match(message, /log_id=gone/);
    assert.match(message, /requested_log_limit=200/);
    assert.match(message, /elapsed_ms=20/);
    assert.match(message, /configured_timeout_ms=20/);
    assert.match(message, /requested_operation=herdr plugin action invoke start --plugin tab-smart-rename/);
    return true;
  });
});
