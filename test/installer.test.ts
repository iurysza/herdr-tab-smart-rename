import { test as bunTest } from "bun:test";

const test = process.platform === "win32" ? bunTest.skip : bunTest;

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { NATIVE_ASSET, packageNative } from "../scripts/package-native.ts";

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

const nativeTag = "v0.6.6";

const nativeCommit = "a".repeat(40);

async function nativeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-bootstrap-"));
  const bin = path.join(root, "bin");
  const source = path.join(root, "checkout");
  const assets = path.join(root, "release");
  const home = path.join(root, "home");
  const temporary = path.join(root, "tmp");
  const entryLog = path.join(root, "entry.jsonl");
  const dependenciesLog = path.join(root, "dependencies.jsonl");
  const curlLog = path.join(root, "curl.jsonl");
  const forbidden = path.join(root, "forbidden.log");

  for (const directory of [bin, home, temporary, path.join(source, "src"), path.join(source, "assets"), path.join(source, "docs"), path.join(source, "scripts"), path.join(source, "installer")]) await mkdir(directory, { recursive: true });
  await writeFile(path.join(source, "package.json"), JSON.stringify({ name: "native-fixture", type: "module", version: "0.6.6", dependencies: { zod: "4.6.7" } }));
  await writeFile(path.join(source, "bun.lock"), "fixture lock");
  await writeFile(path.join(source, "provider.env.example"), "fixture provider example");
  await writeFile(path.join(source, "docs/naming-policy.md"), "fixture naming policy");
  await writeFile(path.join(source, "assets/banner.png"), "fixture image");
  await writeFile(path.join(source, "src/native-install.ts"), `import { appendFile } from "node:fs/promises";
await appendFile(process.env.NATIVE_TEST_ENTRY_LOG, JSON.stringify({argv:process.argv.slice(2),root:import.meta.dir,cwd:process.cwd(),stdinTTY:!!process.stdin.isTTY})+"\\n");
process.exit(Number(process.env.NATIVE_TEST_ENTRY_EXIT||0));
`);

  for (const file of ["native-worker.ts", "native-service.ts", "native-config.ts"]) await writeFile(path.join(source, "src", file), "// fake native runtime, never executed\n");
  await writeFile(path.join(source, "src/run-bun.sh"), await readFile(new URL("../src/run-bun.sh", import.meta.url)));
  await chmod(path.join(source, "src/run-bun.sh"), 0o755);

  for (const file of ["package-native.ts", "render-installer.ts"]) await writeFile(path.join(source, "scripts", file), await readFile(new URL(`../scripts/${file}`, import.meta.url)));
  await writeFile(path.join(source, "installer/install.sh"), await readFile(new URL("../installer/install.sh", import.meta.url)));
  const bun = path.join(bin, "bun");
  await writeFile(bun, `#!${process.execPath}
import { appendFile, mkdir } from "node:fs/promises";
const args=process.argv.slice(2);
if(args[0]==="--version"){console.log(process.env.NATIVE_TEST_BUN_VERSION||"1.4.2");process.exit(0)}
if(args[0]==="install"){
 await appendFile(process.env.NATIVE_TEST_DEPENDENCIES_LOG,JSON.stringify({argv:args,cwd:process.cwd()})+"\\n");
 if(process.env.NATIVE_TEST_DEPENDENCIES_FAIL) process.exit(29);
 await mkdir(process.cwd()+"/node_modules",{recursive:true});process.exit(0);
}
const child=Bun.spawn([${JSON.stringify(process.execPath)},...args],{env:process.env,stdin:"inherit",stdout:"inherit",stderr:"inherit"});
process.exit(await child.exited);
`);
  await chmod(bun, 0o755);
  const curl = path.join(bin, "curl");
  await writeFile(curl, `#!${process.execPath}
import { appendFile, copyFile } from "node:fs/promises";
const args=process.argv.slice(2);await appendFile(process.env.NATIVE_TEST_CURL_LOG,JSON.stringify(args)+"\\n");
if(process.env.NATIVE_TEST_DOWNLOAD_FAIL) process.exit(22);
const output=args[args.indexOf("-o")+1];const url=args.find(arg=>arg.startsWith("https://"));
if(!url||!output) throw Error("unexpected fake curl argv");
await copyFile(process.env.NATIVE_TEST_ASSETS+"/"+url.split("/").at(-1),output);
`);
  await chmod(curl, 0o755);

  for (const name of ["herdr", "herdr-app", "hc", "launchctl"]) {
    await writeFile(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$NATIVE_TEST_FORBIDDEN"\nexit 98\n`);
    await chmod(path.join(bin, name), 0o755);
  }

  await writeFile(path.join(bin, "uname"), "#!/bin/sh\nprintf '%s\\n' \"${NATIVE_TEST_OS:-Darwin}\"\n");
  await chmod(path.join(bin, "uname"), 0o755);
  await writeFile(path.join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' '${nativeCommit}'\n`);
  await chmod(path.join(bin, "git"), 0o755);
  const installer = path.join(assets, "install.sh");

  const bind = async (commitValue = nativeCommit) => {
    const packed = await packageNative({ root: source, tag: nativeTag, commit: commitValue, destination: assets });
    const rendered = await run([process.execPath, "scripts/render-installer.ts", nativeTag, commitValue, installer, packed.archive], process.env);
    assert.equal(rendered.exitCode, 0, rendered.stderr);
    await writeFile(path.join(assets, "SHA256SUMS"), `${packed.sha256}  ${NATIVE_ASSET}\n`);
  };

  await bind();

  const env = {
    ...process.env, HOME: home, TMPDIR: temporary, XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state"), XDG_CONFIG_HOME: path.join(home, "config"),
    PATH: `${bin}:/usr/bin:/bin`, BUN_PATH: bun, HERDR_BIN_PATH: path.join(bin, "herdr"),
    HERDR_APP_BIN_PATH: path.join(bin, "herdr-app"), HC_BIN_PATH: path.join(bin, "hc"),
    NATIVE_TEST_ENTRY_LOG: entryLog, NATIVE_TEST_DEPENDENCIES_LOG: dependenciesLog, NATIVE_TEST_CURL_LOG: curlLog,
    NATIVE_TEST_FORBIDDEN: forbidden, NATIVE_TEST_ASSETS: assets,
  };

  const version = (commitValue = nativeCommit) => path.join(env.XDG_DATA_HOME, "herdr-tab-smart-rename/native/versions", commitValue);
  const lines = async (file: string) => (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

  return { root, bin, source, assets, home, temporary, installer, env, bind, version, lines, entryLog, dependenciesLog, curlLog, forbidden,
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("native release installer verifies and stages a persistent payload, then invokes only the native entry", async () => {
  const f = await nativeFixture();

  try {
    const config = path.join(f.home, "private config");
    const result = await run(["/bin/sh", f.installer, "--native", "--config-dir", config], f.env);
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    const entries = await f.lines(f.entryLog);
    assert.deepEqual(entries[0].argv, ["install", "--config-dir", config]);
    assert.equal(entries[0].root, path.join(f.version(), "src"));
    const dependencies = await f.lines(f.dependenciesLog);
    assert.deepEqual(dependencies[0].argv, ["install", "--production", "--frozen-lockfile", "--ignore-scripts"]);
    assert.ok(path.basename(dependencies[0].cwd).startsWith(`.stage.${nativeCommit}.`));
    assert.equal((await stat(path.join(f.version(), "src/run-bun.sh"))).mode & 0o777, 0o755);
    const receipt = JSON.parse(await readFile(path.join(f.version(), ".native-dependencies.json"), "utf8"));
    assert.match(receipt.payloadSha256, /^[a-f\d]{64}$/);
    await assert.rejects(readFile(f.forbidden), /ENOENT/);
    await assert.rejects(readFile(path.join(path.dirname(f.version()), "../activation.json")), /ENOENT/);
    await assert.rejects(readFile(path.join(f.home, ".local/bin/smart-rename-native")), /ENOENT/);
    assert.deepEqual(await readdir(f.temporary), []);
    const downloads = await f.lines(f.curlLog);
    assert.ok(downloads.every((args) => args.some((arg: string) => arg.includes(`/releases/download/${nativeTag}/`))));
  } finally { await f.cleanup(); }
}, { timeout: 30_000 });

test("native bootstrap reuses an unchanged version and publishes upgrades side by side", async () => {
  const f = await nativeFixture();

  try {
    for (let index = 0; index < 2; index++) {
      const result = await run(["/bin/sh", f.installer, "--native"], f.env);
      assert.equal(result.exitCode, 0, result.stderr);
    }

    assert.equal((await f.lines(f.dependenciesLog)).length, 1);
    assert.equal((await f.lines(f.entryLog)).length, 2);
    const next = "b".repeat(40);
    await f.bind(next);
    const upgrade = await run(["/bin/sh", f.installer, "--native"], f.env);
    assert.equal(upgrade.exitCode, 0, upgrade.stderr);
    assert.equal((await f.lines(f.dependenciesLog)).length, 2);
    await readFile(path.join(f.version(), "src/native-install.ts"));
    await readFile(path.join(f.version(next), "src/native-install.ts"));
  } finally { await f.cleanup(); }
}, { timeout: 30_000 });

test("native status and uninstall need neither app/core executables nor daemon commands", async () => {
  for (const action of ["status", "uninstall"]) {
    const f = await nativeFixture();

    try {
      await rm(f.env.HERDR_APP_BIN_PATH);
      await rm(f.env.HC_BIN_PATH);
      const result = await run(["/bin/sh", f.installer, "--native", `--${action}`], f.env);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual((await f.lines(f.entryLog))[0].argv, [action]);
      await assert.rejects(readFile(f.forbidden), /ENOENT/);
    } finally { await f.cleanup(); }
  }
}, { timeout: 30_000 });

test("native bootstrap propagates the service entry exit code and retains its verified payload", async () => {
  const f = await nativeFixture();

  try {
    const result = await run(["/bin/sh", f.installer, "--native"], { ...f.env, NATIVE_TEST_ENTRY_EXIT: "23" });
    assert.equal(result.exitCode, 23, result.stderr);
    await readFile(path.join(f.version(), "src/native-install.ts"));
    assert.deepEqual(await readdir(f.temporary), []);
  } finally { await f.cleanup(); }
}, { timeout: 30_000 });

test("native bootstrap rejects corrupted payloads or checksum manifests before dependency or service execution", async () => {
  for (const target of [NATIVE_ASSET, "SHA256SUMS"]) {
    const f = await nativeFixture();

    try {
      await writeFile(path.join(f.assets, target), "corrupted download");
      const result = await run(["/bin/sh", f.installer, "--native"], f.env);
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /bound checksum mismatch/);
      await assert.rejects(readFile(f.dependenciesLog), /ENOENT/);
      await assert.rejects(readFile(f.entryLog), /ENOENT/);
      assert.deepEqual(await readdir(path.dirname(f.version())), []);
      assert.deepEqual(await readdir(f.temporary), []);
    } finally { await f.cleanup(); }
  }
}, { timeout: 30_000 });

test("native bootstrap refuses unsafe archive paths even with a matching bound checksum", async () => {
  const f = await nativeFixture();

  try {
    const archivePath = path.join(f.assets, NATIVE_ASSET);
    const bytes = gunzipSync(await readFile(archivePath));
    const header = bytes.subarray(0, 512);
    header.fill(0, 0, 100);
    header.write("../escape");
    header.fill(32, 148, 156);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8);
    const archive = gzipSync(bytes);
    await writeFile(archivePath, archive);
    const hash = createHash("sha256").update(archive).digest("hex");
    await writeFile(path.join(f.assets, "SHA256SUMS"), `${hash}  ${NATIVE_ASSET}\n`);
    const render = await run([process.execPath, "scripts/render-installer.ts", nativeTag, nativeCommit, f.installer, archivePath], process.env);
    assert.equal(render.exitCode, 0, render.stderr);
    const result = await run(["/bin/sh", f.installer, "--native"], f.env);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /unsafe or unsupported archive entry/);
    await assert.rejects(readFile(f.entryLog), /ENOENT/);
    await assert.rejects(readFile(f.dependenciesLog), /ENOENT/);
    assert.deepEqual(await readdir(path.dirname(f.version())), []);
  } finally { await f.cleanup(); }
}, { timeout: 30_000 });

test("native dependency or download failures leave no partial published version", async () => {
  for (const failure of ["NATIVE_TEST_DEPENDENCIES_FAIL", "NATIVE_TEST_DOWNLOAD_FAIL"]) {
    const f = await nativeFixture();

    try {
      const result = await run(["/bin/sh", f.installer, "--native"], { ...f.env, [failure]: "1" });
      assert.notEqual(result.exitCode, 0);
      await assert.rejects(readFile(f.entryLog), /ENOENT/);
      await assert.rejects(readFile(path.join(f.version(), "native-release.json")), /ENOENT/);
      assert.deepEqual(await readdir(f.temporary), []);
    } finally { await f.cleanup(); }
  }
}, { timeout: 30_000 });

test("native bootstrap refuses modified existing version files rather than replacing them", async () => {
  const f = await nativeFixture();

  try {
    assert.equal((await run(["/bin/sh", f.installer, "--native"], f.env)).exitCode, 0);
    const file = path.join(f.version(), "src/native-worker.ts");
    await writeFile(file, "user change must survive");
    const result = await run(["/bin/sh", f.installer, "--native"], f.env);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /existing version was modified/);
    assert.equal(await readFile(file, "utf8"), "user change must survive");
    assert.equal((await f.lines(f.entryLog)).length, 1);
  } finally { await f.cleanup(); }
}, { timeout: 30_000 });

test("native bootstrap names missing requirements without contacting app or daemon", async () => {
  const f = await nativeFixture();

  try {
    const unsupported = await run(["/bin/sh", f.installer, "--native"], { ...f.env, NATIVE_TEST_OS: "Linux" });
    assert.match(unsupported.stderr, /requires macOS/);
    const missing = await run(["/bin/sh", f.installer, "--native"], { ...f.env, BUN_PATH: path.join(f.root, "missing-bun") });
    assert.match(missing.stderr, /Bun 1\.2\.23 or newer is required/);
    const oldBun = await run(["/bin/sh", f.installer, "--native"], { ...f.env, NATIVE_TEST_BUN_VERSION: "1.2.22" });
    assert.match(oldBun.stderr, /Bun 1\.2\.23 or newer is required \(found 1\.2\.22\)/);
    const app = await run(["/bin/sh", f.installer, "--native"], { ...f.env, HERDR_APP_BIN_PATH: path.join(f.root, "missing-app") });
    assert.match(app.stderr, /native app\/core executable not found/);
    await assert.rejects(readFile(f.entryLog), /ENOENT/);
    await assert.rejects(readFile(f.forbidden), /ENOENT/);
  } finally { await f.cleanup(); }
}, { timeout: 30_000 });

test("local checkout native command packages and verifies its own bound snapshot without downloads", async () => {
  const f = await nativeFixture();

  try {
    const result = await run(["/bin/sh", path.join(f.source, "installer/install.sh"), "--native"], f.env);
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual((await f.lines(f.entryLog))[0].argv, ["install"]);
    assert.equal((await f.lines(f.entryLog))[0].root, path.join(f.version(), "src"));
    await assert.rejects(readFile(f.curlLog), /ENOENT/);
    await assert.rejects(readFile(f.forbidden), /ENOENT/);
    assert.deepEqual(await readdir(f.temporary), []);
  } finally { await f.cleanup(); }
}, { timeout: 30_000 });

test("piped native install recovers its caller terminal for setup", async () => {
  const f = await nativeFixture();
  const wrapper = path.join(f.root, "native-pty.sh");
  await writeFile(wrapper, '#!/bin/sh\n/bin/sh "$NATIVE_TEST_RENDERED_INSTALLER" --native\n');

  try {
    const result = await runPipedPty(wrapper, { ...f.env, NATIVE_TEST_RENDERED_INSTALLER: f.installer });
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal((await f.lines(f.entryLog))[0].stdinTTY, true);
    await assert.rejects(readFile(f.forbidden), /ENOENT/);
  } finally { await f.cleanup(); }
}, { timeout: 30_000 });

test("native bootstrap refuses unowned extra version files and preserves them", async () => {
  const f = await nativeFixture();

  try {
    assert.equal((await run(["/bin/sh", f.installer, "--native"], f.env)).exitCode, 0);
    const unowned = path.join(f.version(), ".env");
    await writeFile(unowned, "user-owned file");
    const result = await run(["/bin/sh", f.installer, "--native"], f.env);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /unowned entry in existing native version/);
    assert.equal(await readFile(unowned, "utf8"), "user-owned file");
    assert.equal((await f.lines(f.entryLog)).length, 1);
  } finally { await f.cleanup(); }
}, { timeout: 30_000 });
