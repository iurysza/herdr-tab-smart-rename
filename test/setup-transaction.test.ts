import { test } from "bun:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { modelSelectionPath } from "../src/model-selection.ts";
import { providerEnvPath } from "../src/provider.ts";
import { beginSetupTransaction } from "../src/setup-transaction.ts";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "smart-rename-transaction-"));
  const config = path.join(root, "config");
  return { root, config };
}

test("restores exact prior bytes and modes for Direct setup files", async () => {
  const { root, config } = await fixture();
  const selection = modelSelectionPath(config);
  const provider = providerEnvPath({ HERDR_PLUGIN_CONFIG_DIR: config })!;
  try {
    await mkdir(config, { recursive: true });
    await Bun.write(selection, "old selection\n");
    await Bun.write(provider, "SMART_RENAME_API_KEY=old-secret\n");
    await chmod(config, 0o750);
    await chmod(selection, 0o640);
    await chmod(provider, 0o600);
    const transaction = await beginSetupTransaction(config, { includesDirect: true });

    await writeFile(selection, "new selection\n");
    await writeFile(provider, "SMART_RENAME_API_KEY=new-secret\n");
    await chmod(config, 0o700);
    await chmod(selection, 0o600);
    await chmod(provider, 0o644);
    await transaction.rollback();

    assert.equal(await readFile(selection, "utf8"), "old selection\n");
    assert.equal(await readFile(provider, "utf8"), "SMART_RENAME_API_KEY=old-secret\n");
    if (process.platform !== "win32") {
      assert.equal((await stat(config)).mode & 0o777, 0o750);
      assert.equal((await stat(selection)).mode & 0o777, 0o640);
      assert.equal((await stat(provider)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes files and an absent config directory created by a failed setup", async () => {
  const { root, config } = await fixture();
  const selection = modelSelectionPath(config);
  try {
    const transaction = await beginSetupTransaction(config);
    await mkdir(config, { recursive: true });
    await Bun.write(selection, "new selection\n");
    await transaction.rollback();
    await assert.rejects(stat(selection));
    await assert.rejects(stat(config));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("committed validated configuration is not rolled back after worker start failure", async () => {
  const { root, config } = await fixture();
  const selection = modelSelectionPath(config);
  try {
    const transaction = await beginSetupTransaction(config);
    await mkdir(config, { recursive: true });
    await Bun.write(selection, "validated selection\n");
    transaction.commit();
    await transaction.rollback();
    assert.equal(await readFile(selection, "utf8"), "validated selection\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
