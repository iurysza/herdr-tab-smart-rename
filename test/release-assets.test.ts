import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NATIVE_ASSET, packageNative } from "../scripts/package-native.ts";

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
  assert.match(workflow, /download\/install\.sh download\/SHA256SUMS download\/smart-rename-native\.tar\.gz/);
  assert.match(workflow, /scripts\/package-native\.ts/);
  assert.match(workflow, /sha256sum install\.sh smart-rename-native\.tar\.gz > SHA256SUMS/);
  assert.match(workflow, /--frozen-lockfile --ignore-scripts/);
  assert.doesNotMatch(workflow, /smart-rename-installer|matrix:|build:installer/);
});

test("native installer rendering embeds the archive checksum and a trusted extraction verifier", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-render-binding-"));
  const project = path.resolve(import.meta.dir, "..");
  const { version } = await Bun.file(path.join(project, "package.json")).json();
  const commit = "a".repeat(40);

  try {
    const payload = await packageNative({ root: project, tag: `v${version}`, commit, destination: root });
    const installer = path.join(root, "install.sh");
    const result = await command(["scripts/render-installer.ts", `v${version}`, commit, installer, path.join(root, NATIVE_ASSET)]);
    assert.equal(result.exitCode, 0, result.stderr);
    const text = await readFile(installer, "utf8");
    assert.match(text, new RegExp(`^NATIVE_PAYLOAD_SHA256="${payload.sha256}"$`, "m"));
    assert.match(text, /unsafe or unsupported archive entry/);
    assert.match(text, /release identity mismatch/);
    assert.doesNotMatch(text, /__NATIVE_PAYLOAD_/);

    if (process.platform !== "win32") {
      const syntax = Bun.spawn(["/bin/sh", "-n", installer], { stdout: "pipe", stderr: "pipe" });
      assert.equal(await syntax.exited, 0, await new Response(syntax.stderr).text());
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
