import { chmod, readFile, writeFile } from "node:fs/promises";

const [tag, commit, destination] = process.argv.slice(2);
if (!tag || !commit || !destination) {
  throw new Error("Usage: bun scripts/render-installer.ts v<version> <commit> <destination>");
}
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error(`Release tag must be semantic: ${tag}`);
}
if (!/^[0-9a-f]{40}$/i.test(commit)) {
  throw new Error(`Release commit must be a 40-character Git SHA: ${commit}`);
}
const template = await readFile(new URL("../installer/install.sh", import.meta.url), "utf8");
const rendered = template
  .replaceAll("__RELEASE_TAG__", tag)
  .replaceAll("__RELEASE_COMMIT__", commit);
if (rendered.includes("__RELEASE_TAG__") || rendered.includes("__RELEASE_COMMIT__")) {
  throw new Error("Installer rendering left release placeholders");
}
await writeFile(destination, rendered, { mode: 0o755 });
await chmod(destination, 0o755);
