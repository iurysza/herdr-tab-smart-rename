import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";

test("release-please owns the package version and updates the plugin manifest", async () => {
  const [packageSource, releaseManifestSource, configSource] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(
      new URL("../.release-please-manifest.json", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../release-please-config.json", import.meta.url), "utf8"),
  ]);

  const packageJson = z.object({ version: z.string() }).parse(JSON.parse(packageSource));

  const releaseManifest = z.record(z.string(), z.string()).parse(JSON.parse(releaseManifestSource));

  const packageConfig = z.looseObject({
    "release-type": z.string(),
    "package-name": z.string(),
    "include-component-in-tag": z.boolean(),
    "include-v-in-tag": z.boolean(),
    "extra-files": z.array(z.looseObject({ type: z.string(), path: z.string(), jsonpath: z.string() })),
  });

  const config = z.object({ packages: z.record(z.string(), packageConfig) }).parse(JSON.parse(configSource));

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
