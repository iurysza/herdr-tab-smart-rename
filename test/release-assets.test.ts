import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function command(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

test("release renders a tag-bound shell installer and validates version agreement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smart-rename-release-assets-"));
  const destination = path.join(root, "install.sh");
  try {
    const commit = "5e6026c880e7a37dc580d269fdd8327d8007f77b";
    const rendered = await command(["scripts/render-installer.ts", "v0.2.0", commit, destination]);
    assert.equal(rendered.exitCode, 0, rendered.stderr);
    const installer = await readFile(destination, "utf8");
    assert.match(installer, /^RELEASE_TAG="v0\.2\.0"$/m);
    assert.match(installer, new RegExp(`^RELEASE_COMMIT="${commit}"$`, "m"));
    assert.doesNotMatch(installer, /__RELEASE_(?:TAG|COMMIT)__/);

    const { version: packageVersion } = await Bun.file(new URL("../package.json", import.meta.url)).json();
    const version = await command(["scripts/check-release-version.ts", `v${packageVersion}`, commit]);
    assert.equal(version.exitCode, 0, version.stderr);
    const [major, minor, patch] = packageVersion.split(".").map(Number);
    const mismatch = await command(["scripts/check-release-version.ts", `v${major}.${minor}.${patch + 1}`, commit]);
    assert.notEqual(mismatch.exitCode, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release workflow publishes no compiled installer assets", async () => {
  const workflow = await readFile(new URL("../.github/workflows/installer-assets.yml", import.meta.url), "utf8");
  assert.match(workflow, /types: \[published\]/);
  assert.match(workflow, /scripts\/render-installer\.ts/);
  assert.doesNotMatch(workflow, /workflow_dispatch|--clobber/);
  assert.match(workflow, /download\/install\.sh download\/SHA256SUMS/);
  assert.doesNotMatch(workflow, /smart-rename-installer|matrix:|build:installer/);
});
