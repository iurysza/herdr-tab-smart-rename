import { readFile } from "node:fs/promises";

const [tag, expectedCommit] = process.argv.slice(2);
if (!tag) throw new Error("Usage: bun scripts/check-release-version.ts v<version> [expected-commit]");
const match = tag.match(/^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
if (!match) throw new Error(`Release tag must be semantic and start with v: ${tag}`);
const version = match[1]!;
const [packageJson, manifest] = await Promise.all([
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../herdr-plugin.toml", import.meta.url), "utf8"),
]);
const packageVersion = (JSON.parse(packageJson) as { version?: string }).version;
const manifestVersion = Bun.TOML.parse(manifest).version;
if (packageVersion !== version || manifestVersion !== version) {
  throw new Error(`Release tag ${tag} must match package.json (${packageVersion}) and herdr-plugin.toml (${manifestVersion})`);
}
if (expectedCommit && !/^[0-9a-f]{40}$/i.test(expectedCommit)) {
  throw new Error(`Expected release commit must be a 40-character Git SHA: ${expectedCommit}`);
}
console.log(version);
