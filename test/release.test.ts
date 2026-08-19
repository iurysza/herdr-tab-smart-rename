import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("release-please owns the package version and updates the plugin manifest", async () => {
  const [packageSource, releaseManifestSource, configSource] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(
      new URL("../.release-please-manifest.json", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../release-please-config.json", import.meta.url), "utf8"),
  ]);
  const packageJson = JSON.parse(packageSource) as { version: string };
  const releaseManifest = JSON.parse(releaseManifestSource) as Record<
    string,
    string
  >;
  const config = JSON.parse(configSource) as {
    packages: Record<string, Record<string, unknown>>;
  };

  assert.equal(releaseManifest["."], packageJson.version);
  assert.deepEqual(config.packages["."], {
    "release-type": "node",
    "package-name": "herdr-tab-smart-rename",
    "include-component-in-tag": false,
    "include-v-in-tag": true,
    "extra-files": [
      {
        type: "toml",
        path: "herdr-plugin.toml",
        jsonpath: "$.version",
      },
    ],
  });
});
