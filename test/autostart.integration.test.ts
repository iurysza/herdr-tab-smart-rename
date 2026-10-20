import { test as bunTest } from "bun:test";

const test = process.platform === "win32" ? bunTest.skip : bunTest;

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const pluginRoot = path.resolve(import.meta.dir, "..");

const workerScript = path.join(pluginRoot, "src", "worker.ts");

const skippedLine = "Smart Rename has no saved setup; autostart skipped.\n";

interface Started {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(args: string[], env: NodeJS.ProcessEnv): Promise<Started> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: pluginRoot,
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

interface Fixture {
  readonly root: string;
  readonly state: string;
  readonly config: string;
  readonly env: NodeJS.ProcessEnv;
  connections: number;
  close(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "smart-rename-autostart-"));
  const socket = path.join(root, "herdr.sock");
  const state = path.join(root, "state");
  const config = path.join(root, "config");
  const herdr = path.join(root, "herdr");
  let connections = 0;

  const server = net.createServer((connection) => {
    connections += 1;
    connection.resume();
  });

  await mkdir(state);
  await mkdir(config);
  await writeFile(
    herdr,
    `#!/bin/sh
set -eu
case "$1 \${2:-}" in
  "api snapshot") printf '%s\\n' '{"result":{"snapshot":{"workspaces":[],"tabs":[],"panes":[],"layouts":[]}}}' ;;
  "notification show") : ;;
  *) printf '%s\\n' "unexpected fake Herdr command: $*" >&2; exit 9 ;;
esac
`,
  );
  await chmod(herdr, 0o700);
  const ps = path.join(root, "ps");
  await writeFile(
    ps,
    `#!${process.execPath}\nconst info = JSON.parse(await Bun.file(${JSON.stringify(path.join(state, "worker.json"))}).text());\nif (process.argv[3] !== String(info.pid)) process.exit(1);\nconsole.log("bun " + info.script);\n`,
  );
  await chmod(ps, 0o700);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });

  return {
    root,
    state,
    config,
    get connections() {
      return connections;
    },
    env: {
      ...process.env,
      PATH: `${root}${path.delimiter}${process.env.PATH}`,
      HERDR_PLUGIN_ROOT: pluginRoot,
      HERDR_PLUGIN_STATE_DIR: state,
      HERDR_PLUGIN_CONFIG_DIR: config,
      HERDR_SOCKET_PATH: socket,
      HERDR_BIN_PATH: herdr,
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function stopIfStarted(env: NodeJS.ProcessEnv, started: Started): Promise<void> {
  if (!started.stdout.includes("started and ready")) return;

  const stopped = await run(["src/cli.ts", "stop"], env);
  assert.equal(stopped.exitCode, 0, stopped.stderr);
}

test("manual start still starts when setup files are absent", async () => {
  const box = await fixture();

  try {
    const started = await run(["src/cli.ts", "start"], box.env);
    assert.equal(started.exitCode, 0, started.stderr);
    assert.match(started.stdout, /started and ready/);
    assert.equal(box.connections, 1);
    await stopIfStarted(box.env, started);
  } finally {
    await box.close();
  }
});

test("autostart starts after a saved model selection", async () => {
  const box = await fixture();

  try {
    await writeFile(
      path.join(box.config, "model-selection.json"),
      `${JSON.stringify({
        version: 1,
        source: "direct",
        provider: "direct",
        model: "direct",
      })}\n`,
    );
    const started = await run(["src/cli.ts", "start", "--autostart"], box.env);
    assert.equal(started.exitCode, 0, started.stderr);
    assert.match(started.stdout, /started and ready/);
    assert.equal(box.connections, 1);
    await stopIfStarted(box.env, started);
  } finally {
    await box.close();
  }
});

test("autostart starts when only provider.env exists", async () => {
  const box = await fixture();

  try {
    await writeFile(path.join(box.config, "provider.env"), "SMART_RENAME_MODEL=example\n");
    const started = await run(["src/cli.ts", "start", "--autostart"], box.env);
    assert.equal(started.exitCode, 0, started.stderr);
    assert.match(started.stdout, /started and ready/);
    assert.equal(box.connections, 1);
    await stopIfStarted(box.env, started);
  } finally {
    await box.close();
  }
});

test("autostart skips a plugin with no saved setup", async () => {
  const box = await fixture();

  try {
    const started = await run(["src/cli.ts", "start", "--autostart"], box.env);
    await stopIfStarted(box.env, started);
    assert.equal(started.exitCode, 0, started.stderr);
    assert.equal(started.stdout, skippedLine);
    assert.equal(started.stderr, "");
    assert.equal(box.connections, 0);
    await assert.rejects(readFile(path.join(box.state, "worker.json"), "utf8"));
  } finally {
    await box.close();
  }
});

async function otherSocket(box: Fixture): Promise<ReturnType<typeof Bun.spawn>> {
  await writeFile(
    path.join(box.config, "model-selection.json"),
    `${JSON.stringify({ version: 1, source: "direct", provider: "direct", model: "direct" })}\n`,
  );

  const sleeper = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1_000_000)"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });

  await writeFile(
    path.join(box.state, "worker.json"),
    `${JSON.stringify({
      pid: sleeper.pid,
      script: workerScript,
      startedAt: new Date().toISOString(),
      socket: path.join(box.root, "other.sock"),
      readyAt: new Date().toISOString(),
    })}\n`,
  );

  return sleeper;
}

test("autostart leaves a worker on another socket alone", async () => {
  const box = await fixture();
  const sleeper = await otherSocket(box);

  try {
    const started = await run(["src/cli.ts", "start", "--autostart"], box.env);
    assert.equal(started.exitCode, 0, started.stderr);
    assert.equal(started.stdout, "");
    assert.equal(started.stderr, "");
    assert.equal(box.connections, 0);
    const record = JSON.parse(await readFile(path.join(box.state, "worker.json"), "utf8"));
    assert.equal(record.pid, sleeper.pid);
  } finally {
    sleeper.kill();
    await box.close();
  }
});

test("manual start still reports a worker on another socket", async () => {
  const box = await fixture();
  const sleeper = await otherSocket(box);

  try {
    const started = await run(["src/cli.ts", "start"], box.env);
    assert.equal(started.exitCode, 1);
    assert.equal(started.stdout, "");
    assert.match(started.stderr, /already serving another Herdr session/);
    assert.equal(box.connections, 0);
  } finally {
    sleeper.kill();
    await box.close();
  }
});
