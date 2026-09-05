import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  inspectKeybindings,
  resolveHerdrConfigPath,
  type KeybindingAction,
} from "../src/setup-keybindings.ts";

const requested: readonly KeybindingAction[] = ["rename-now", "rename-all"];

async function fixture(content: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "smart-rename-keys-"));
  const config = path.join(root, "config.toml");
  await writeFile(config, content);
  return { root, config };
}

function validRunner(checks: string[]) {
  return async (_command: string, _args: readonly string[], env: NodeJS.ProcessEnv) => {
    const file = env.HERDR_CONFIG_PATH!;
    checks.push(file);
    return { exitCode: 0, stdout: "valid\n", stderr: "" };
  };
}

test("recognizes both existing Smart Rename actions without candidate writes", async () => {
  const { root, config } = await fixture(`[[keys.command]]
type = "plugin_action"
command = "tab-smart-rename.rename-now"

[[keys.command]]
type = "plugin_action"
command = "tab-smart-rename.rename-all"
`);
  try {
    const checks: string[] = [];
    const inspected = await inspectKeybindings(requested, { HERDR_CONFIG_PATH: config }, { run: validRunner(checks) });
    assert.deepEqual(inspected.results.map((item) => item.status), ["already-configured", "already-configured"]);
    assert.deepEqual(checks, [config]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates each missing action independently and leaves source config byte-for-byte unchanged", async () => {
  const content = `[[keys.command]]
type = "plugin_action"
command = "tab-smart-rename.rename-now"
`;
  const { root, config } = await fixture(content);
  try {
    const checks: string[] = [];
    const inspected = await inspectKeybindings(requested, { HERDR_CONFIG_PATH: config }, { run: validRunner(checks) });
    assert.deepEqual(inspected.results.map((item) => item.status), ["already-configured", "available"]);
    assert.equal(checks.length, 2);
    assert.notEqual(checks[1], config);
    await assert.rejects(stat(checks[1]!));
    assert.equal(await readFile(config, "utf8"), content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("names collisions and never selects another key", async () => {
  const { root, config } = await fixture("[theme]\nname = \"plain\"\n");
  try {
    const seen: string[] = [];
    const inspected = await inspectKeybindings(requested, { HERDR_CONFIG_PATH: config }, {
      run: async (_command, _args, env) => {
        const candidate = await readFile(env.HERDR_CONFIG_PATH!, "utf8");
        seen.push(candidate);
        if (env.HERDR_CONFIG_PATH === config) return { exitCode: 0, stdout: "valid", stderr: "" };
        return candidate.includes("prefix+alt+t")
          ? { exitCode: 1, stdout: "", stderr: "key is already bound" }
          : { exitCode: 0, stdout: "valid", stderr: "" };
      },
    });
    assert.deepEqual(inspected.results.map((item) => item.status), ["available", "colliding"]);
    assert.match(inspected.results[1]?.diagnostic || "", /key is already bound/);
    assert.ok(seen.some((value) => value.includes("prefix+t")));
    assert.ok(seen.some((value) => value.includes("prefix+alt+t")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns uncertainty for missing, invalid, and unreadable ownership boundaries", async () => {
  const missing = await inspectKeybindings(requested, { HOME: "/no-such-home" });
  assert.deepEqual(missing.results.map((item) => item.status), ["uncertain", "uncertain"]);
  assert.match(missing.uncertainty || "", /unavailable/);
  assert.match(missing.remoteAttachNote, /attaching client/);

  const { root, config } = await fixture("value = [\n");
  try {
    const invalid = await inspectKeybindings(requested, { HERDR_CONFIG_PATH: config }, { run: validRunner([]) });
    assert.deepEqual(invalid.results.map((item) => item.status), ["uncertain", "uncertain"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves explicit, XDG, and HOME config paths without writing them", async () => {
  assert.equal(resolveHerdrConfigPath({ HERDR_CONFIG_PATH: "/custom.toml", HOME: "/home/user" }), "/custom.toml");
  assert.equal(resolveHerdrConfigPath({ XDG_CONFIG_HOME: "/xdg" }), "/xdg/herdr/config.toml");
  assert.equal(resolveHerdrConfigPath({ HOME: "/home/user" }), "/home/user/.config/herdr/config.toml");
  assert.equal(resolveHerdrConfigPath({}), undefined);
});
