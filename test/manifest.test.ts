import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const INTERNAL_COMMANDS = new Set(["once", "dry-run"]);

function documentedCliCommands(source: string): string[] {
  const usage = source.match(/"usage: cli\.ts ([^"]+)"/)?.[1];
  assert.ok(usage, "CLI usage string not found");
  return usage.split("|").map((entry) => entry.trim().split(/\s+/)[0]!);
}

function manifestCliCommands(source: string): string[] {
  const commands: string[] = [];
  const actionBlocks = source
    .split(/\n(?=\[\[)/)
    .filter((block) => block.startsWith("[[actions]]"));
  for (const block of actionBlocks) {
    const encodedArgs = block.match(/^command = \[(.*)\]$/m)?.[1];
    assert.ok(encodedArgs, "plugin action command not found");
    const args = JSON.parse(`[${encodedArgs}]`) as string[];
    assert.deepEqual(args.slice(0, 3), ["sh", "src/run-bun.sh", "src/cli.ts"]);
    assert.ok(args[3], "plugin action CLI command not found");
    commands.push(args[3]);
  }
  return commands;
}

test("documented CLI actions are registered in the Herdr manifest", async () => {
  const [cli, manifest] = await Promise.all([
    readFile(new URL("../src/cli.ts", import.meta.url), "utf8"),
    readFile(new URL("../herdr-plugin.toml", import.meta.url), "utf8"),
  ]);
  const documented = documentedCliCommands(cli).filter(
    (command) => !INTERNAL_COMMANDS.has(command),
  );
  assert.deepEqual(manifestCliCommands(manifest).sort(), documented.sort());
});
