import { test as bunTest } from "bun:test";
const test = process.platform === "win32" ? bunTest.skip : bunTest;
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

async function run(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: path.resolve(import.meta.dir, ".."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

test("start does not return before the isolated worker connects to its target socket", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smart-rename-worker-ready-"));
  const socket = path.join(root, "herdr.sock");
  const state = path.join(root, "state");
  const herdr = path.join(root, "herdr");
  const pluginRoot = path.resolve(import.meta.dir, "..");
  let connected = false;
  const server = net.createServer((connection) => {
    connected = true;
    connection.resume();
  });
  try {
    await writeFile(herdr, `#!/bin/sh
set -eu
case "$1 \${2:-}" in
  "api snapshot") printf '%s\\n' '{"result":{"snapshot":{"workspaces":[],"tabs":[],"panes":[],"layouts":[]}}}' ;;
  "notification show") : ;;
  *) printf '%s\\n' "unexpected fake Herdr command: $*" >&2; exit 9 ;;
esac
`);
    await chmod(herdr, 0o700);
    // macOS blocks the setuid /bin/ps inside Seatbelt. This fake boundary
    // reports only the PID/script in this fixture's private worker record.
    const ps = path.join(root, "ps");
    await writeFile(ps, `#!${process.execPath}\nconst info = JSON.parse(await Bun.file(${JSON.stringify(path.join(state, "worker.json"))}).text());\nif (process.argv[3] !== String(info.pid)) process.exit(1);\nconsole.log("bun " + info.script);\n`);
    await chmod(ps, 0o700);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    const env = {
      ...process.env,
      PATH: `${root}${path.delimiter}${process.env.PATH}`,
      HERDR_PLUGIN_ROOT: pluginRoot,
      HERDR_PLUGIN_STATE_DIR: state,
      HERDR_SOCKET_PATH: socket,
      HERDR_BIN_PATH: herdr,
    };
    const started = await run(["src/cli.ts", "start"], env);
    assert.equal(started.exitCode, 0, started.stderr + await readFile(path.join(state, "worker.log"), "utf8").catch(() => ""));
    assert.equal(connected, true, started.stdout);
    assert.match(started.stdout, /started and ready/);
    const stopped = await run(["src/cli.ts", "stop"], env);
    assert.equal(stopped.exitCode, 0, stopped.stderr);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
