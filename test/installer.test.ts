import { test as bunTest } from "bun:test";
const test = process.platform === "win32" ? bunTest.skip : bunTest;
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tag = "v0.2.0";
const commit = "0123456789abcdef";

interface Fixture {
  readonly root: string;
  readonly installer: string;
  readonly herdr: string;
  readonly pluginFile: string;
  readonly expectedPlugin: string;
  readonly setupLog: string;
  readonly commandLog: string;
  readonly temporaryRoot: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "smart-rename-installer-"));
  const bin = path.join(root, "bin");
  const managedRoot = path.join(root, "managed");
  const temporaryRoot = path.join(root, "tmp");
  const pluginFile = path.join(root, "plugin.json");
  const expectedPlugin = path.join(root, "expected-plugin.json");
  const setupLog = path.join(root, "setup.json");
  const commandLog = path.join(root, "herdr.log");
  const herdr = path.join(bin, "herdr");
  const installer = path.join(root, "install.sh");
  await Promise.all([
    mkdir(bin, { recursive: true }),
    mkdir(path.join(managedRoot, "src"), { recursive: true }),
    mkdir(temporaryRoot, { recursive: true }),
  ]);
  await Bun.write(path.join(managedRoot, "src", "setup.ts"), [
    'await Bun.write(process.env.SMART_RENAME_TEST_SETUP_LOG!, JSON.stringify({',
    '  root: process.env.HERDR_PLUGIN_ROOT,',
    '  config: process.env.HERDR_PLUGIN_CONFIG_DIR,',
    '  socket: process.env.HERDR_SOCKET_PATH,',
    '}));',
    'process.exit(Number(process.env.SMART_RENAME_TEST_SETUP_EXIT || "0"));',
  ].join("\n"));
  const plugin = {
    result: {
      plugins: [{
        plugin_id: "tab-smart-rename",
        plugin_root: managedRoot,
        source: {
          kind: "github",
          owner: "iurysza",
          repo: "herdr-tab-smart-rename",
          requested_ref: tag,
          resolved_commit: commit,
        },
      }],
    },
  };
  await writeFile(expectedPlugin, JSON.stringify(plugin));
  await writeFile(herdr, `#!/bin/sh
set -eu
printf '%s|socket=%s\n' "$*" "\${HERDR_SOCKET_PATH:-}" >> "$SMART_RENAME_TEST_COMMAND_LOG"
case "$1 \${2:-}" in
  "--version ") printf '%s\n' 'herdr 0.7.0' ;;
  "status server") printf '%s\n' '{"running":true,"compatible":true}' ;;
  "plugin list") if [ -f "$SMART_RENAME_TEST_PLUGIN_FILE" ]; then cat "$SMART_RENAME_TEST_PLUGIN_FILE"; else printf '%s\n' '{"result":{"plugins":[]}}'; fi ;;
  "plugin install")
    case "\${SMART_RENAME_TEST_INSTALL_OUTCOME:-success}" in
      success) cp "$SMART_RENAME_TEST_EXPECTED_PLUGIN" "$SMART_RENAME_TEST_PLUGIN_FILE" ;;
      wrong) printf '%s\n' '{"result":{"plugins":[{"id":"tab-smart-rename","root":"/wrong","source":{"owner":"wrong","repo":"wrong","ref":"wrong"},"commit":"wrong"}]}}' > "$SMART_RENAME_TEST_PLUGIN_FILE" ;;
      declined) : ;;
      failed) exit 17 ;;
    esac ;;
  "plugin config-dir") printf '%s\n' "$SMART_RENAME_TEST_CONFIG_DIR" ;;
  *) printf '%s\n' "unexpected fake Herdr command: $*" >&2; exit 9 ;;
esac
`);
  await chmod(herdr, 0o700);
  const source = await readFile(new URL("../installer/install.sh", import.meta.url), "utf8");
  await writeFile(
    installer,
    source.replaceAll("__RELEASE_TAG__", tag).replaceAll("__RELEASE_COMMIT__", commit),
    { mode: 0o700 },
  );
  return { root, installer, herdr, pluginFile, expectedPlugin, setupLog, commandLog, temporaryRoot };
}

function environment(value: Fixture, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BUN_PATH: process.execPath,
    HERDR_BIN_PATH: value.herdr,
    HERDR_SOCKET_PATH: "/tmp/isolated-herdr.sock",
    SMART_RENAME_TEST_PLUGIN_FILE: value.pluginFile,
    SMART_RENAME_TEST_EXPECTED_PLUGIN: value.expectedPlugin,
    SMART_RENAME_TEST_SETUP_LOG: value.setupLog,
    SMART_RENAME_TEST_COMMAND_LOG: value.commandLog,
    SMART_RENAME_TEST_CONFIG_DIR: path.join(value.root, "config"),
    TMPDIR: value.temporaryRoot,
    ...extra,
  };
}

async function run(
  command: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([...command], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function runPipedPty(
  installer: string,
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const python = [
    "import os, pty",
    "pid, fd = pty.fork()",
    "if pid == 0:",
    "    os.execvpe('/bin/sh', ['/bin/sh', '-c', \"printf '' | /bin/sh \\\"$SMART_RENAME_TEST_INSTALLER\\\"\"], os.environ)",
    "chunks = []",
    "while True:",
    "    try:",
    "        chunk = os.read(fd, 4096)",
    "        if not chunk: break",
    "        chunks.append(chunk)",
    "    except OSError: break",
    "_, status = os.waitpid(pid, 0)",
    "os.write(1, b''.join(chunks))",
    "raise SystemExit(os.waitstatus_to_exitcode(status))",
  ].join("\n");
  return run(["python3", "-c", python], {
    ...env,
    SMART_RENAME_TEST_INSTALLER: installer,
  });
}

test("shell installer checks syntax and needs a caller terminal before changing state", async () => {
  const value = await fixture();
  try {
    const syntax = await run(["sh", "-n", value.installer], environment(value));
    assert.equal(syntax.exitCode, 0, syntax.stderr);
    const result = await run(["/bin/sh", value.installer], environment(value));
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /interactive caller terminal/);
    await assert.rejects(readFile(value.commandLog));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("shell installer supports explicit non-interactive install-only without setup", async () => {
  const value = await fixture();
  try {
    const result = await run(["/bin/sh", value.installer, "--install-only", "--yes"], environment(value));
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(await readFile(value.pluginFile, "utf8"), await readFile(value.expectedPlugin, "utf8"));
    await assert.rejects(readFile(value.setupLog));
    const commands = await readFile(value.commandLog, "utf8");
    assert.match(commands, /plugin install iurysza\/herdr-tab-smart-rename --ref v0\.2\.0 --yes\|socket=\/tmp\/isolated-herdr\.sock/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("shell installer rejects declined and wrong managed releases before setup", async () => {
  for (const outcome of ["declined", "wrong"] as const) {
    const value = await fixture();
    try {
      const result = await runPipedPty(value.installer, environment(value, {
        SMART_RENAME_TEST_INSTALL_OUTCOME: outcome,
      }));
      assert.notEqual(result.exitCode, 0, `${outcome} installer unexpectedly succeeded`);
      await assert.rejects(readFile(value.setupLog));
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("piped default installation uses the caller terminal and propagates setup state", async () => {
  const value = await fixture();
  try {
    const result = await runPipedPty(value.installer, environment(value));
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(await readFile(value.setupLog, "utf8")), {
      root: path.join(value.root, "managed"),
      config: path.join(value.root, "config"),
      socket: "/tmp/isolated-herdr.sock",
    });
    const temporaryEntries = await readdir(value.temporaryRoot).catch(() => []);
    assert.deepEqual(temporaryEntries.filter((entry) => entry.startsWith("smart-rename-install.")), []);

    const rerun = await run(["/bin/sh", value.installer, "--install-only", "--yes"], environment(value));
    assert.equal(rerun.exitCode, 0, rerun.stderr);
    const commands = await readFile(value.commandLog, "utf8");
    assert.equal((commands.match(/plugin install/g) ?? []).length, 1);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("shell installer returns the managed setup exit code", async () => {
  const value = await fixture();
  try {
    const result = await runPipedPty(value.installer, environment(value, {
      SMART_RENAME_TEST_SETUP_EXIT: "23",
    }));
    assert.equal(result.exitCode, 23, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
