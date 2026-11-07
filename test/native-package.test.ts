import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { NATIVE_ASSET, nativePayloadProgram, packageNative } from "../scripts/package-native.ts";

const tag = "v0.6.6";

const commit = "a".repeat(40);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-package-"));
  const source = path.join(root, "source");
  const output = path.join(root, "assets");
  await mkdir(path.join(source, "src"), { recursive: true });
  await mkdir(path.join(source, "assets"));
  await mkdir(path.join(source, "docs"));

  for (const name of ["native-worker.ts", "native-install.ts", "native-config.ts", "native-service.ts", "run-bun.sh"]) await writeFile(path.join(source, "src", name), `fixture ${name}\n`);
  await writeFile(path.join(source, "package.json"), JSON.stringify({ name: "native-fixture", type: "module", version: "0.6.6", dependencies: { zod: "4.6.7" } }));
  await writeFile(path.join(source, "bun.lock"), "fixture frozen lock\n");
  await writeFile(path.join(source, "provider.env.example"), "SMART_RENAME_MODEL=example\n");
  await writeFile(path.join(source, "docs/naming-policy.md"), "fixture naming policy\n");
  await writeFile(path.join(source, "assets/banner.png"), "fixture image");
  const options = { root: source, tag, commit, destination: output };

  return { root, source, output, options, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function entries(archive: Buffer): Map<string, { bytes: Buffer; mode: number }> {
  const bytes = gunzipSync(archive);
  const files = new Map<string, { bytes: Buffer; mode: number }>();

  for (let offset = 0; bytes[offset] !== 0;) {
    const header = bytes.subarray(offset, offset + 512);
    const field = (start: number, length: number) => header.subarray(start, start + length).toString().split("\0")[0]!.trim();
    const size = parseInt(field(124, 12), 8);
    files.set(field(0, 100), { bytes: bytes.subarray(offset + 512, offset + 512 + size), mode: parseInt(field(100, 8), 8) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }

  return files;
}

async function verify(root: string, archive: Buffer, mode = "extract") {
  const destination = path.join(root, "destination");
  await mkdir(destination, { recursive: true });
  const file = path.join(root, NATIVE_ASSET);
  const sums = path.join(root, "SHA256SUMS");
  const hash = createHash("sha256").update(archive).digest("hex");
  await writeFile(file, archive);
  await writeFile(sums, `${hash}  ${NATIVE_ASSET}\n`);

  const child = Bun.spawn([process.execPath, "-e", nativePayloadProgram], {
    env: { HOME: root, NATIVE_ARCHIVE: file, NATIVE_SUMS: sums, NATIVE_PAYLOAD_SHA256: hash,
      NATIVE_RELEASE_TAG: tag, NATIVE_RELEASE_COMMIT: commit, NATIVE_DESTINATION: destination, NATIVE_PAYLOAD_MODE: mode },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

  return { destination, stdout, stderr, exitCode, hash };
}

test("native payload allowlists source and required assets, excluding credentials and installed dependencies", async () => {
  const f = await fixture();

  try {
    await mkdir(path.join(f.source, "node_modules"));
    await mkdir(path.join(f.source, "test"));
    await mkdir(path.join(f.source, ".git"));
    await writeFile(path.join(f.source, "provider.env"), "PRIVATE_KEY=never-package");
    await writeFile(path.join(f.source, ".env"), "PRIVATE_KEY=never-package");
    await writeFile(path.join(f.source, "src/local.env"), "PRIVATE_KEY=never-package");
    await writeFile(path.join(f.source, "src/unit.test.ts"), "test source");
    await writeFile(path.join(f.source, "assets/provider.env"), "PRIVATE_KEY=never-package");
    await mkdir(path.join(f.source, "src/tests"));
    await writeFile(path.join(f.source, "src/tests/fixture.ts"), "PRIVATE_KEY=never-package");
    const packaged = await packageNative(f.options);
    const archive = await readFile(packaged.archive);
    const files = entries(archive);
    assert.equal(files.get("src/run-bun.sh")?.mode, 0o755);
    assert.equal(files.get("src/native-install.ts")?.mode, 0o644);
    assert.ok(files.has("bun.lock"));
    assert.ok(files.has("assets/banner.png"));
    assert.ok(files.has("provider.env.example"));
    assert.ok(files.has("docs/naming-policy.md"));
    assert.ok([...files.keys()].every((name) => !/^(?:test|node_modules|\.git)\//.test(name)));
    assert.equal(files.has("provider.env"), false);
    assert.equal(files.has("src/unit.test.ts"), false);
    assert.equal(files.has("assets/provider.env"), false);
    assert.equal(files.has("src/tests/fixture.ts"), false);
    assert.equal(gunzipSync(archive).includes("never-package"), false);
    const metadata = JSON.parse(files.get("native-release.json")!.bytes.toString());
    assert.equal(metadata.commit, commit);
    assert.equal(metadata.tag, tag);
    assert.equal(metadata.packageVersion, "0.6.6");
    assert.equal(metadata.files.length, files.size - 1);
    const again = await packageNative(f.options);
    assert.equal(again.sha256, packaged.sha256);
    const verified = await verify(f.root, archive);
    assert.equal(verified.exitCode, 0, verified.stderr);
    assert.equal((await stat(path.join(verified.destination, "src/run-bun.sh"))).mode & 0o777, 0o755);
  } finally { await f.cleanup(); }
});

test("real checkout packaging includes every native module and current production dependency declarations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-real-source-package-"));
  const project = path.resolve(import.meta.dir, "..");
  const { version } = await Bun.file(path.join(project, "package.json")).json();

  try {
    const packaged = await packageNative({ root: project, tag: `v${version}`, commit, destination: root });
    const files = entries(await readFile(packaged.archive));

    for (const name of ["native-worker.ts", "native-service.ts", "native-install.ts", "native-config.ts", "setup.ts", "herdr-app.ts"]) assert.ok(files.has(`src/${name}`));
    const config = JSON.parse(files.get("package.json")!.bytes.toString());
    assert.ok(config.dependencies.zod);
    assert.ok(config.dependencies["@earendil-works/pi-coding-agent"]);
    assert.equal(files.has("node_modules"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const attack of ["../escape", "/absolute/escape", "src/../../escape", "src//alias.ts", "symlink", "hardlink", "pax"] as const) {
  test(`native extraction refuses ${attack} before writing any payload file`, async () => {
    const f = await fixture();

    try {
      const result = await packageNative(f.options);
      const bytes = gunzipSync(await readFile(result.archive));
      const header = bytes.subarray(0, 512);

      const flags = new Map([["symlink", "2"], ["hardlink", "1"], ["pax", "x"]]);
      const flag = flags.get(attack);

      if (flag) header.write(flag, 156);
      else { header.fill(0, 0, 100); header.write(attack, 0); }

      header.fill(32, 148, 156);
      header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8);
      const checked = await verify(f.root, gzipSync(bytes));
      assert.notEqual(checked.exitCode, 0);
      assert.match(checked.stderr, /unsafe or unsupported archive entry/);
      assert.deepEqual(await readdir(checked.destination), []);
      await assert.rejects(stat(path.join(f.root, "escape")), /ENOENT/);
    } finally { await f.cleanup(); }
  });
}

test("release metadata must match the bound commit even when archive checksum matches", async () => {
  const f = await fixture();

  try {
    const result = await packageNative(f.options);
    const bytes = gunzipSync(await readFile(result.archive));
    const needle = Buffer.from(`"commit":"${commit}"`);
    const offset = bytes.indexOf(needle);
    assert.ok(offset >= 0);
    bytes.write(`"commit":"${"b".repeat(40)}"`, offset);
    const checked = await verify(f.root, gzipSync(bytes));
    assert.notEqual(checked.exitCode, 0);
    assert.match(checked.stderr, /release identity mismatch/);
    assert.deepEqual(await readdir(checked.destination), []);
  } finally { await f.cleanup(); }
});

test("native packager refuses redirected source and mismatched release versions", async () => {
  const f = await fixture();

  try {
    await assert.rejects(packageNative({ ...f.options, tag: "v9.9.9" }), /tag must match/);
    await assert.rejects(packageNative({ ...f.options, commit: "short" }), /40-character/);
    const file = path.join(f.source, "src/native-worker.ts");
    await rm(file);
    await symlink(path.join(f.source, "package.json"), file);
    await assert.rejects(packageNative(f.options), /refuses symlinks/);
  } finally { await f.cleanup(); }
});
