import { test } from "bun:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadModelSelection,
  modelSelectionPath,
  resolvePluginConfigDirectory,
  saveModelSelection,
} from "../src/model-selection.ts";
import type { ModelSelection } from "../src/model-source.ts";

const selection: ModelSelection = {
  version: 1,
  source: "pi",
  provider: "anthropic",
  model: "claude-sonnet",
  profile: "high",
};

async function tempDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "smart-rename-selection-"));
}

test("model selection rejects invalid files and process values override saved data", async () => {
  const directory = await tempDirectory();
  try {
    await writeFile(modelSelectionPath(directory), '{"version":1,"source":"bad"}');
    await assert.rejects(loadModelSelection(directory), /model-selection\.json is invalid/);

    await saveModelSelection(directory, selection);
    assert.deepEqual(
      await loadModelSelection(directory, {
        SMART_RENAME_MODEL_SOURCE: "opencode",
        SMART_RENAME_PROVIDER: "openai",
        SMART_RENAME_MODEL: "gpt-5.6",
        SMART_RENAME_PROFILE: "fast",
      }),
      {
        version: 1,
        source: "opencode",
        provider: "openai",
        model: "gpt-5.6",
        profile: "fast",
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing selection upgrades to Direct and private writes are atomic", async () => {
  const root = await tempDirectory();
  const directory = path.join(root, "config");
  try {
    assert.deepEqual(await loadModelSelection(directory), {
      version: 1,
      source: "direct",
      provider: "direct",
      model: "direct",
    });

    await saveModelSelection(directory, selection);
    const file = modelSelectionPath(directory);
    if (process.platform !== "win32") {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), selection);

    await assert.rejects(
      saveModelSelection(
        directory,
        { ...selection, model: "replacement" },
        {
          mkdir,
          chmod,
          rename,
          rm,
          writeFile: async () => {
            throw new Error("disk full");
          },
        },
      ),
      /disk full/,
    );
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), selection);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct setup resolves the Herdr-owned config directory when needed", async () => {
  const directory = await tempDirectory();
  try {
    assert.equal(
      await resolvePluginConfigDirectory({}, async (command, args) => {
        assert.equal(command, "herdr");
        assert.deepEqual(args, ["plugin", "config-dir", "tab-smart-rename"]);
        return { stdout: `${directory}\n`, exitCode: 0 };
      }),
      directory,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
