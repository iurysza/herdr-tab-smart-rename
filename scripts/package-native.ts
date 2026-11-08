import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

export const NATIVE_ASSET = "smart-rename-native.tar.gz";

interface PayloadFile {
  path: string;
  bytes: Buffer;
  mode: number;
}

export interface NativePackageOptions {
  root: string;
  tag: string;
  commit: string;
  destination: string;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tar(files: PayloadFile[]): Buffer {
  const chunks: Buffer[] = [];

  for (const file of files) {
    const header = Buffer.alloc(512);

    if (Buffer.byteLength(file.path) > 100) throw new Error("Native archive path exceeds the 100-byte USTAR name field");
    header.write(file.path, 0, 100);
    const octal = (value: number, start: number, length: number) => header.write(value.toString(8).padStart(length - 1, "0") + "\0", start, length);
    octal(file.mode, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(file.bytes.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    chunks.push(header, file.bytes, Buffer.alloc((512 - file.bytes.length % 512) % 512));
  }

  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

export async function packageNative(options: NativePackageOptions): Promise<{ archive: string; sha256: string }> {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.tag) || !/^[a-f\d]{40}$/.test(options.commit))
    throw new Error("Native package requires a semantic release tag and a 40-character lowercase commit");
  const files: PayloadFile[] = [];

  const add = async (relative: string): Promise<void> => {
    const source = path.join(options.root, relative);
    const details = await lstat(source);

    if (!/^[A-Za-z\d_./-]+$/.test(relative)) throw new Error(`Unsupported native source path: ${relative}`);

    if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Native payload requires a regular source file: ${relative}`);
    files.push({ path: relative, bytes: await readFile(source), mode: relative === "src/run-bun.sh" ? 0o755 : 0o644 });
  };

  const tree = async (relative: string): Promise<void> => {
    const directory = path.join(options.root, relative);
    const details = await lstat(directory);

    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`Native payload requires a regular source directory: ${relative}`);

    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || ["test", "tests", "node_modules"].includes(entry.name)) continue;
      const name = `${relative}/${entry.name}`;

      if (entry.isSymbolicLink()) throw new Error(`Native payload refuses symlinks: ${name}`);

      if (entry.isDirectory()) await tree(name);
      else {
        const included = relative.startsWith("assets") ? /\.(?:png|jpe?g|webp|gif|svg)$/i.test(entry.name)
          : entry.name === "run-bun.sh" || (entry.name.endsWith(".ts") && !/\.(?:test|spec)\.ts$/.test(entry.name));

        if (included) await add(name);
      }
    }
  };

  await tree("src");
  await tree("assets");

  for (const name of ["package.json", "bun.lock", "provider.env.example", "docs/naming-policy.md"]) await add(name);
  const packageFile = files.find((file) => file.path === "package.json")!;
  const packageJson = JSON.parse(packageFile.bytes.toString("utf8"));

  if (packageJson.version !== options.tag.slice(1)) throw new Error("Native package tag must match package.json version");

  for (const name of ["src/native-worker.ts", "src/native-install.ts", "src/native-service.ts", "src/native-config.ts", "src/run-bun.sh"]) {
    if (!files.some((file) => file.path === name)) throw new Error(`Native payload is missing ${name}`);
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  const manifest = {
    version: 1, tag: options.tag, commit: options.commit, packageVersion: packageJson.version,
    files: files.map((file) => ({ path: file.path, mode: file.mode, sha256: digest(file.bytes) })),
  };

  files.push({ path: "native-release.json", mode: 0o644, bytes: Buffer.from(`${JSON.stringify(manifest)}\n`) });
  const archiveBytes = gzipSync(tar(files));
  await mkdir(options.destination, { recursive: true });
  const archive = path.join(options.destination, NATIVE_ASSET);
  await writeFile(archive, archiveBytes, { mode: 0o644 });
  await chmod(archive, 0o644);

  return { archive, sha256: digest(archiveBytes) };
}

// Rendered into install.sh, so validation never imports code from an unverified
// payload. The private format is regular-file USTAR only, with no tar extraction.
export const nativePayloadProgram = String.raw`
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
const fail = (message) => { throw new Error("Native payload: " + message); };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const expected = process.env.NATIVE_PAYLOAD_SHA256;
const archive = await readFile(process.env.NATIVE_ARCHIVE);
const sums = (await readFile(process.env.NATIVE_SUMS, "utf8")).split(/\r?\n/).filter((line) => /\s\*?smart-rename-native\.tar\.gz$/.test(line));
if (!/^[a-f\d]{64}$/.test(expected) || sums.length !== 1 || sums[0] !== expected + "  smart-rename-native.tar.gz" || hash(archive) !== expected) fail("bound checksum mismatch");
const bytes = gunzipSync(archive);
const entries = new Map();
const allowed = (name) => /^(?:src\/[A-Za-z\d_./-]+\.(?:ts|sh)|assets\/[A-Za-z\d_./-]+|package\.json|bun\.lock|provider\.env\.example|docs\/naming-policy\.md|native-release\.json)$/.test(name) && !name.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."));
const field = (header, start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
const octal = (header, start, length) => { const text = field(header, start, length).trim(); if (!/^[0-7]+$/.test(text)) fail("invalid USTAR number"); const value = parseInt(text, 8); if (!Number.isSafeInteger(value)) fail("invalid USTAR number"); return value; };
let ended = false;
for (let offset = 0; offset + 512 <= bytes.length;) {
  const header = bytes.subarray(offset, offset + 512);
  if (header.every((byte) => byte === 0)) { if (bytes.length - offset < 1024 || !bytes.subarray(offset).every((byte) => byte === 0)) fail("invalid archive ending"); ended = true; break; }
  const name = field(header, 0, 100);
  const type = field(header, 156, 1);
  if (!allowed(name) || entries.has(name) || field(header, 345, 155) || (type !== "0" && type !== "") || field(header, 257, 6) !== "ustar") fail("unsafe or unsupported archive entry");
  let sum = 0;
  for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index];
  if (sum !== octal(header, 148, 8)) fail("invalid USTAR checksum");
  const size = octal(header, 124, 12);
  const mode = octal(header, 100, 8);
  if (mode !== (name === "src/run-bun.sh" ? 493 : 420) || offset + 512 + size > bytes.length) fail("invalid entry size or permissions");
  entries.set(name, { bytes: bytes.subarray(offset + 512, offset + 512 + size), mode });
  offset += 512 + Math.ceil(size / 512) * 512;
}
if (!ended) fail("truncated archive");
const releaseEntry = entries.get("native-release.json");
if (!releaseEntry) fail("missing release metadata");
const release = JSON.parse(releaseEntry.bytes.toString("utf8"));
if (release.version !== 1 || release.tag !== process.env.NATIVE_RELEASE_TAG || release.commit !== process.env.NATIVE_RELEASE_COMMIT || release.packageVersion !== release.tag.slice(1) || !Array.isArray(release.files) || release.files.length !== entries.size - 1) fail("release identity mismatch");
const declared = new Set();
for (const file of release.files) {
  const entry = entries.get(file.path);
  if (!entry || file.path === "native-release.json" || declared.has(file.path) || entry.mode !== file.mode || hash(entry.bytes) !== file.sha256) fail("source manifest mismatch");
  declared.add(file.path);
}
for (const name of ["package.json", "bun.lock", "provider.env.example", "docs/naming-policy.md", "src/native-worker.ts", "src/native-install.ts", "src/native-service.ts", "src/native-config.ts", "src/run-bun.sh"]) if (!declared.has(name)) fail("incomplete source payload");
if (JSON.parse(entries.get("package.json").bytes.toString("utf8")).version !== release.packageVersion) fail("package version mismatch");
const destination = process.env.NATIVE_DESTINATION;
const root = await lstat(destination);
if (!root.isDirectory() || root.isSymbolicLink() || !path.isAbsolute(destination)) fail("destination must be a real directory");
const checking = process.env.NATIVE_PAYLOAD_MODE === "check";
for (const [name, entry] of entries) {
  let parent = destination;
  for (const part of name.split("/").slice(0, -1)) {
    parent = path.join(parent, part);
    if (!checking) await mkdir(parent, { recursive: true, mode: 448 });
    const details = await lstat(parent);
    if (!details.isDirectory() || details.isSymbolicLink()) fail("redirected source directory");
  }
  const target = path.join(destination, name);
  if (checking) {
    const details = await lstat(target);
    if (!details.isFile() || details.isSymbolicLink() || (details.mode & 511) !== entry.mode || hash(await readFile(target)) !== hash(entry.bytes)) fail("existing version was modified; refusing to replace it");
  } else { await writeFile(target, entry.bytes, { mode: entry.mode, flag: "wx" }); await chmod(target, entry.mode); }
}
if (checking) {
  const known = new Set([...entries.keys(), ".native-dependencies.json"]);
  const directories = new Set([...entries.keys()].flatMap((name) => { const parts = name.split("/"); return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/")); }));
  const inspect = async (relative) => {
    for (const item of await readdir(path.join(destination, relative), { withFileTypes: true })) {
      if (!relative && item.name === "node_modules") continue;
      const name = relative ? relative + "/" + item.name : item.name;
      if (item.isDirectory() && directories.has(name)) await inspect(name);
      else if (!item.isFile() || !known.has(name)) fail("unowned entry in existing native version");
    }
  };
  await inspect("");
  const modules = await lstat(path.join(destination, "node_modules"));
  const markerFile = path.join(destination, ".native-dependencies.json");
  const markerDetails = await lstat(markerFile);
  if (!modules.isDirectory() || modules.isSymbolicLink() || !markerDetails.isFile() || markerDetails.isSymbolicLink()) fail("unowned dependency directory");
  const marker = JSON.parse(await readFile(markerFile, "utf8"));
  if (marker.version !== 1 || marker.payloadSha256 !== expected) fail("unverified existing dependencies");
}
`;

if (import.meta.main) {
  const [tag, commit, destination] = process.argv.slice(2);

  if (!tag || !commit || !destination) throw new Error("Usage: bun scripts/package-native.ts v<version> <commit> <destination-directory>");
  const result = await packageNative({ root: path.resolve(import.meta.dir, ".."), tag, commit, destination });
  console.log(`${result.sha256}  ${NATIVE_ASSET}`);
}
