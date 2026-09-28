import { test } from "bun:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beginProgress, progressBase } from "../src/herdr.ts";

// A fake Herdr CLI that keeps labels in a JSON file and logs rename calls.
async function fakeHerdr(tabLabel: string, paneLabel?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "smart-rename-progress-"));
  const stateFile = path.join(root, "labels.json");
  const logFile = path.join(root, "calls.log");
  const bin = path.join(root, "herdr");

  await writeFile(stateFile, JSON.stringify({ tab: tabLabel, pane: paneLabel }));
  await writeFile(logFile, "");
  await writeFile(bin, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const labels = JSON.parse(readFileSync(${JSON.stringify(stateFile)}, "utf8"));
if (args[0] === "api" && args[1] === "snapshot") {
  const pane = { pane_id: "p1", tab_id: "t1", workspace_id: "w1", agent: "pi" };
  if (labels.pane !== undefined) pane.label = labels.pane;
  console.log(JSON.stringify({ result: { snapshot: {
    workspaces: [], layouts: [],
    tabs: [{ tab_id: "t1", workspace_id: "w1", label: labels.tab, number: 1 }],
    panes: [pane],
  } } }));
} else if (args[1] === "rename") {
  appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n");
  const label = args[3] === "--clear" ? undefined : args.slice(3).join(" ");
  labels[args[0]] = label;
  writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(labels));
} else process.exit(9);
`);
  await chmod(bin, 0o700);

  return {
    env: { ...process.env, HERDR_BIN_PATH: bin },
    labels: async () =>
      // SAFETY: only this fixture writes the file, always with this shape.
      JSON.parse(await readFile(stateFile, "utf8")) as {
        tab: string;
        pane?: string;
      },
    setTab: async (tab: string) => {
      const labels = JSON.parse(await readFile(stateFile, "utf8"));
      await writeFile(stateFile, JSON.stringify({ ...labels, tab }));
    },
    calls: async () =>
      (await readFile(logFile, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          // SAFETY: the fake CLI logs each call as a JSON array of strings.
          const call = JSON.parse(line) as string[];

          return call;
        }),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("static marker shows while renaming and restores the original label", async () => {
  const herdr = await fakeHerdr("Review Auth");

  try {
    const stop = await beginProgress({ kind: "tab", id: "t1" }, herdr.env);
    const marked = (await herdr.labels()).tab;
    assert.equal(progressBase(marked), "Review Auth");
    // A second request never nests a marker on top of the first.
    await (await beginProgress({ kind: "tab", id: "t1" }, herdr.env))();
    assert.equal((await herdr.labels()).tab, marked);
    await stop();
    assert.equal((await herdr.labels()).tab, "Review Auth");
    // Static: exactly one write to mark and one to restore.
    assert.equal((await herdr.calls()).length, 2);
  } finally {
    await herdr.close();
  }
});

test("restoring never overwrites a new name or a manual edit", async () => {
  const herdr = await fakeHerdr("1");

  try {
    const stop = await beginProgress({ kind: "tab", id: "t1" }, herdr.env);
    await herdr.setTab("My Own Name");
    await stop();
    assert.equal((await herdr.labels()).tab, "My Own Name");
  } finally {
    await herdr.close();
  }
});

test("an empty pane label is marked and cleared again", async () => {
  const herdr = await fakeHerdr("1");

  try {
    const stop = await beginProgress({ kind: "pane", id: "p1" }, herdr.env);
    assert.equal(progressBase((await herdr.labels()).pane ?? ""), "");
    await stop();
    assert.equal((await herdr.labels()).pane, undefined);
    assert.deepEqual((await herdr.calls()).at(-1), [
      "pane",
      "rename",
      "p1",
      "--clear",
    ]);
  } finally {
    await herdr.close();
  }
});
