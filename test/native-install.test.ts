import { test as bunTest } from "bun:test";

// LaunchAgents, POSIX artifact modes and the shell wrapper are macOS contracts.
const test = process.platform === "win32" ? bunTest.skip : bunTest;

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nativeInstall, nativeInstallMain, nativeInstallOptions, type NativeInstallOptions } from "../src/native-install.ts";
import {
  createNativeServiceController, nativeInstallPaths, NATIVE_SERVICE_LABEL, renderNativePlist,
  type NativeActivation, type NativeServiceController, type NativeServiceProcess,
} from "../src/native-service.ts";
import { saveDirectProviderConfig } from "../src/configure.ts";
import { saveModelSelection } from "../src/model-selection.ts";
import { acquireLock } from "../src/storage.ts";
import type { NativeWorkerStatus } from "../src/native-worker.ts";

const selection = { version: 1 as const, source: "direct" as const, provider: "openai", model: "fixture-model" };

function decodeXml(text: string): string {
  return text.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "native-install-")));
  const fakeApp = path.join(root, "fake-app");
  const fakeCore = path.join(root, "fake-hc");
  const invoked = path.join(root, "unexpected-invocation");

  for (const executable of [fakeApp, fakeCore]) {
    await writeFile(executable, `#!/bin/sh\nprintf invoked >> '${invoked}'\nexit 99\n`);
    await chmod(executable, 0o700);
  }

  const env = {
    HOME: root, PATH: "/usr/bin:/bin", XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"), XDG_DATA_HOME: path.join(root, "data"),
    HERDR_APP_BIN_PATH: fakeApp, HC_BIN_PATH: fakeCore,
    HERDR_APP_HOME: path.join(root, "native app & 'home'"), HC_SESSION: "fixture-session",
    PI_CODING_AGENT_DIR: path.join(root, "pi"), SMART_RENAME_API_KEY: "inherited-provider-secret",
    OPENAI_API_KEY: "another-inherited-secret", HERDR_TAB_ID: "daemon-tab-do-not-inherit",
  };

  const paths = nativeInstallPaths(env);
  const versions = ["a".repeat(40), "b".repeat(40)].map((commit) => path.join(paths.dataRoot, "versions", commit));

  for (const source of versions) {
    await mkdir(path.join(source, "src"), { recursive: true });
    await writeFile(path.join(source, "src/run-bun.sh"), await readFile(path.resolve(import.meta.dir, "../src/run-bun.sh")));
    await chmod(path.join(source, "src/run-bun.sh"), 0o755);
    await writeFile(path.join(source, "src/native-worker.ts"), "// fixture payload, never started\n");
    await writeFile(path.join(source, "src/native-install.ts"), "// fixture payload, never started\n");
  }

  let process: NativeServiceProcess = { state: "absent" };
  let nextPid = 4000;
  let now = Date.now();
  let setupCalls = 0;
  let bootstrapMode: "ready" | "waiting" | "failed" | "stale" | "wrong-pid" | "throw" | "partial-throw" = "ready";
  const calls: string[] = [];
  const activatedRoots: string[] = [];
  const activatedProviders: Buffer[] = [];
  let targetCounts: NativeWorkerStatus["targets"] = { active: 0, waiting: 0, blocked: 0 };
  let lastError: NativeWorkerStatus["lastError"];

  const controller: NativeServiceController = {
    inspect: async () => {
      calls.push("inspect");

      return process;
    },
    bootstrap: async (file) => {
      calls.push("bootstrap");
      assert.equal(file, paths.plist);
      const mode = bootstrapMode;
      bootstrapMode = "ready";

      if (mode === "throw") throw new Error("injected launchctl error SECRET=never-log");
      const xml = await readFile(file, "utf8");
      const argumentArray = /<key>ProgramArguments<\/key><array>(.*?)<\/array>/s.exec(xml)?.[1];
      assert.ok(argumentArray);
      const args = [...argumentArray.matchAll(/<string>(.*?)<\/string>/gs)].map((match) => decodeXml(match[1]!));
      assert.equal(args.length, 6);
      assert.equal(args[2], "--config-dir");
      assert.equal(args[4], "--runtime-dir");
      const program = args[0]!;
      const runtimeDir = args[5]!;
      activatedProviders.push(await readFile(path.join(args[3]!, "provider.env")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return Buffer.alloc(0);
        throw error;
      }));
      activatedRoots.push(path.resolve(program, "../.."));
      process = { state: "loaded", pid: ++nextPid, program, plist: file };
      await mkdir(runtimeDir, { recursive: true });

      const health: NativeWorkerStatus = {
        version: 1, pid: mode === "wrong-pid" ? nextPid + 999 : nextPid,
        state: mode === "waiting" || mode === "failed" ? mode : "ready", managedTabs: 0,
        updatedAt: new Date(mode === "stale" ? now - 1000 : now).toISOString(),
        targets: targetCounts,
        detail: "SECRET=untrusted-health-detail",
      };

      if (lastError) health.lastError = lastError;
      await writeFile(path.join(runtimeDir, "status.json"), JSON.stringify(health));

      if (mode === "partial-throw") throw new Error("injected partial bootstrap failure");
    },
    bootout: async () => { calls.push("bootout"); process = { state: "absent" }; },
  };

  const setup = async (setupEnv: NodeJS.ProcessEnv) => {
    setupCalls++;
    assert.equal(setupEnv.SMART_RENAME_API_KEY, undefined);
    assert.equal(setupEnv.OPENAI_API_KEY, undefined);
    assert.equal(setupEnv.HERDR_TAB_ID, undefined);
    await saveDirectProviderConfig({ provider: "openai", baseURL: "https://fixture.invalid/v1", model: "fixture-model", apiKey: "persisted-private-secret", timeoutMs: 45000 }, setupEnv);
    await saveModelSelection(setupEnv.HERDR_PLUGIN_CONFIG_DIR!, selection);

    return { saved: true, selection };
  };

  const dependencies = {
    controller, setup, platform: "darwin" as const, now: () => now,
    sleep: async (milliseconds: number) => { now += milliseconds; }, readyTimeoutMs: 300,
  };

  const install = (sourceRoot = versions[0]!, configDir?: string) => {
    const options: NativeInstallOptions = { env, sourceRoot };

    if (configDir) options.configDir = configDir;

    return nativeInstall("install", options, dependencies);
  };

  const activation = async (): Promise<NativeActivation> => JSON.parse(await readFile(paths.activation, "utf8"));

  return {
    root, env, paths, versions, controller, dependencies, calls, activatedRoots, activatedProviders, install, activation, invoked,
    get setupCalls() { return setupCalls; }, get process() { return process; },
    set process(value: NativeServiceProcess) { process = value; },
    set bootstrapMode(value: typeof bootstrapMode) { bootstrapMode = value; },
    set targetCounts(value: NativeWorkerStatus["targets"]) { targetCounts = value; },
    set lastError(value: NativeWorkerStatus["lastError"]) { lastError = value; },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);

    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

test("native paths and CLI use native defaults and require absolute config overrides", () => {
  const paths = nativeInstallPaths({ HOME: "/disposable-home" });
  assert.equal(paths.configDir, "/disposable-home/.config/herdr-tab-smart-rename/native");
  assert.equal(paths.runtimeDir, "/disposable-home/.local/state/herdr-tab-smart-rename/native-service");
  assert.equal(paths.dataRoot, "/disposable-home/.local/share/herdr-tab-smart-rename/native");
  assert.equal(paths.wrapper, "/disposable-home/.local/bin/smart-rename-native");
  assert.equal(nativeInstallPaths({ HOME: "/home", HERDR_PLUGIN_CONFIG_DIR: "/kept/config" }).configDir, "/kept/config");
  assert.deepEqual(nativeInstallOptions(["status", "--config-dir", "/private/config"]), { action: "status", configDir: "/private/config" });
  assert.throws(() => nativeInstallOptions(["install", "--config-dir", "relative"]), /usage/);
  assert.throws(() => nativeInstallOptions(["install", "extra"]), /usage/);
  assert.throws(() => nativeInstallOptions(["watch"]), /usage/);
});

test("fresh native install persists only owned artifacts and non-secret launch environment", async () => {
  const f = await fixture();

  try {
    const result = await f.install();
    assert.equal(result.installed, true);
    assert.equal(result.service, "running");
    assert.equal(result.health?.state, "ready");
    assert.equal(f.setupCalls, 1);
    assert.equal(await readlink(f.paths.current), f.versions[0]);
    const activation = await f.activation();
    const plist = await readFile(f.paths.plist, "utf8");
    const wrapper = await readFile(f.paths.wrapper, "utf8");
    assert.equal(plist, renderNativePlist(activation));
    assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
    assert.match(plist, /--config-dir/);
    assert.match(plist, /--runtime-dir/);
    assert.match(plist, /native app &amp; &apos;home&apos;/);
    assert.ok(activation.env.PATH?.includes(path.dirname(process.execPath)));
    assert.equal(activation.env.HC_SESSION, f.env.HC_SESSION);
    assert.equal(activation.env.HERDR_APP_HOME, f.env.HERDR_APP_HOME);
    assert.equal(activation.env.HERDR_PLUGIN_ROOT, f.versions[0]);
    assert.equal(plist.includes("API_KEY"), false);
    assert.equal(wrapper.includes("secret"), false);
    assert.equal(JSON.stringify(activation).includes("secret"), false);
    assert.equal(JSON.stringify(result).includes("untrusted-health-detail"), false);
    assert.equal((await stat(f.paths.activation)).mode & 0o777, 0o600);
    assert.equal((await stat(f.paths.plist)).mode & 0o777, 0o600);
    assert.equal((await stat(f.paths.wrapper)).mode & 0o777, 0o755);
    assert.equal((await stat(f.paths.dataRoot)).mode & 0o777, 0o700);
    assert.equal(await fileExists(f.invoked), false, "installer must not call the fake app or core");
  } finally { await f.cleanup(); }
});

test("repeat install preserves private config, custom config path and payload versions", async () => {
  const f = await fixture();
  const configDir = path.join(f.root, "custom-private-config");

  try {
    await f.install(f.versions[0], configDir);
    const config = await readFile(path.join(configDir, "provider.env"));
    await f.install(f.versions[1]);
    assert.equal(f.setupCalls, 1);
    assert.deepEqual(await readFile(path.join(configDir, "provider.env")), config);
    assert.equal((await f.activation()).configDir, configDir);
    assert.equal(await readlink(f.paths.current), f.versions[1]);
    assert.equal(await fileExists(f.versions[0]!), true);
    assert.equal(f.calls.filter((call) => call === "bootout").length, 1);
    await f.install(f.versions[1]);
    assert.equal(f.setupCalls, 1);
    assert.equal(await readlink(f.paths.current), f.versions[1]);
  } finally { await f.cleanup(); }
});

for (const mode of ["throw", "partial-throw", "waiting", "failed", "stale", "wrong-pid"] as const) {
  test(`failed upgrade restores prior service and exact artifacts after ${mode}`, async () => {
    const f = await fixture();

    try {
      await f.install();
      const saved = await Promise.all([f.paths.activation, f.paths.wrapper, f.paths.plist].map((file) => readFile(file)));
      await chmod(f.paths.wrapper, 0o750);
      f.bootstrapMode = mode;
      await assert.rejects(f.install(f.versions[1]), mode === "waiting" || mode === "stale" || mode === "wrong-pid" ? /NATIVE_READY_TIMEOUT_MS=300ms/ : /failed/);
      const restored = await Promise.all([f.paths.activation, f.paths.wrapper, f.paths.plist].map((file) => readFile(file)));
      assert.deepEqual(restored, saved);
      assert.equal((await stat(f.paths.wrapper)).mode & 0o777, 0o750);
      assert.equal(await readlink(f.paths.current), f.versions[0]);
      assert.equal(f.process.state, "loaded");
      assert.equal(f.activatedRoots.at(-1), f.versions[0]);
      assert.equal(f.setupCalls, 1);
    } finally { await f.cleanup(); }
  });
}

test("failed first activation restores absent setup and leaves no active service or wrapper", async () => {
  const f = await fixture();
  f.bootstrapMode = "waiting";

  try {
    await assert.rejects(f.install(), /NATIVE_READY_TIMEOUT_MS=300ms/);
    assert.equal(f.process.state, "absent");

    for (const file of [f.paths.activation, f.paths.wrapper, f.paths.plist, path.join(f.paths.configDir, "provider.env"), path.join(f.paths.configDir, "model-selection.json")])
      assert.equal(await fileExists(file), false);
    await assert.rejects(readlink(f.paths.current), /ENOENT/);
    assert.equal(await fileExists(f.versions[0]!), true, "prepared immutable payload is retained");
  } finally { await f.cleanup(); }
});

test("setup cancellation enables no service and preserves an existing activation", async () => {
  const f = await fixture();
  const dependencies = { ...f.dependencies, hasConfiguration: async () => false, setup: async () => ({ saved: false }) };

  try {
    const cancelled = await nativeInstall("install", { env: f.env, sourceRoot: f.versions[0]! }, dependencies);
    assert.equal(cancelled.cancelled, true);
    assert.equal(f.calls.includes("bootstrap"), false);
    assert.equal(await fileExists(f.paths.wrapper), false);
    await f.install();
    const before = await readFile(f.paths.activation);
    const calls = f.calls.length;
    const result = await nativeInstall("install", { env: f.env, sourceRoot: f.versions[1]! }, dependencies);
    assert.equal(result.cancelled, true);
    assert.deepEqual(await readFile(f.paths.activation), before);
    assert.equal(f.calls.slice(calls).includes("bootout"), false);
  } finally { await f.cleanup(); }
});

test("status and uninstall work without app/core binaries, provider config or retained payload source", async () => {
  const f = await fixture();

  try {
    await f.install();
    await rm(f.paths.configDir, { recursive: true });
    await rm(f.env.HERDR_APP_BIN_PATH);
    await rm(f.env.HC_BIN_PATH);
    await rm(f.versions[0]!, { recursive: true });
    const inspected = await nativeInstallMain(["status"], { env: f.env }, f.dependencies);
    assert.equal(inspected.installed, true);
    assert.equal(inspected.service, "running");
    assert.equal(inspected.health?.state, "ready");
    assert.equal(f.setupCalls, 1);
    const removed = await nativeInstallMain(["uninstall"], { env: f.env }, f.dependencies);
    assert.equal(removed.installed, false);
    assert.equal(f.process.state, "absent");
    assert.equal(await fileExists(f.paths.wrapper), false);
    assert.equal(await fileExists(f.paths.plist), false);
    assert.equal(await fileExists(f.paths.activation), false);
    assert.equal(await fileExists(path.join(f.paths.runtimeDir, "status.json")), true);
    const repeated = await nativeInstall("uninstall", { env: f.env }, f.dependencies);
    assert.equal(repeated.installed, false);
    assert.equal(repeated.service, "absent");
    assert.equal(repeated.trigger?.mod, "absent");
    assert.equal(repeated.trigger?.key, "no-keys-file");
  } finally { await f.cleanup(); }
});

test("uninstall keeps private configuration, native state and all version payloads", async () => {
  const f = await fixture();

  try {
    await f.install();
    const provider = await readFile(path.join(f.paths.configDir, "provider.env"));
    const state = path.join(f.env.XDG_STATE_HOME, "herdr-tab-smart-rename/native/tab-state/state.json");
    await mkdir(path.dirname(state), { recursive: true });
    await writeFile(state, "user native ownership state");
    await nativeInstall("uninstall", { env: f.env }, f.dependencies);
    assert.deepEqual(await readFile(path.join(f.paths.configDir, "provider.env")), provider);
    assert.equal(await readFile(state, "utf8"), "user native ownership state");
    assert.equal(await fileExists(f.versions[0]!), true);
    assert.equal(await fileExists(f.versions[1]!), true);
  } finally { await f.cleanup(); }
});

for (const artifact of ["wrapper", "plist", "activation", "current"] as const) {
  test(`install refuses an unrelated ${artifact} before setup or service changes`, async () => {
    const f = await fixture();

    try {
      const target = f.paths[artifact];
      await mkdir(path.dirname(target), { recursive: true });

      if (artifact === "current") await symlink(f.root, target);
      else await writeFile(target, "unrelated user content");
      await assert.rejects(f.install(), /refusing/i);
      assert.equal(f.setupCalls, 0);
      assert.equal(f.calls.includes("bootout"), false);
      assert.equal(f.calls.includes("bootstrap"), false);

      if (artifact === "current") assert.equal(await readlink(target), f.root);
      else assert.equal(await readFile(target, "utf8"), "unrelated user content");
    } finally { await f.cleanup(); }
  });
}

test("modified owned files and a foreign loaded service are never overwritten or stopped", async () => {
  const f = await fixture();

  try {
    f.process = { state: "loaded", pid: 1234, plist: "/unrelated.plist", program: "/unrelated/program" };
    await assert.rejects(f.install(), /unrelated LaunchAgent/);
    assert.equal(f.calls.includes("bootout"), false);
    f.process = { state: "absent" };
    await f.install();
    const original = await readFile(f.paths.wrapper);
    await writeFile(f.paths.wrapper, "user changed this wrapper");
    const before = f.calls.length;
    await assert.rejects(f.install(f.versions[1]), /changed or belong/);
    await assert.rejects(nativeInstall("uninstall", { env: f.env }, f.dependencies), /changed or belong/);
    assert.equal(f.calls.slice(before).includes("bootout"), false);
    await writeFile(f.paths.wrapper, original);
    assert.equal((await nativeInstall("status", { env: f.env }, f.dependencies)).service, "running");
  } finally { await f.cleanup(); }
});

test("changed current pointer and symlinked artifacts cannot redirect native install writes", async () => {
  const f = await fixture();

  try {
    await f.install();
    await rm(f.paths.wrapper);
    const userFile = path.join(f.root, "unrelated-file");
    await writeFile(userFile, "preserve this file");
    await symlink(userFile, f.paths.wrapper);
    await assert.rejects(f.install(f.versions[1]), /non-regular/);
    assert.equal(await readFile(userFile, "utf8"), "preserve this file");
  } finally { await f.cleanup(); }
});

test("install requires a persistent canonical payload and serializes activation", async () => {
  const f = await fixture();

  try {
    await assert.rejects(f.install(f.root), /persistent versions/);
    assert.equal(f.setupCalls, 0);
    const release = await acquireLock(f.paths.lock, { timeoutMs: 0 });

    try { await assert.rejects(f.install(), /timed out waiting for lock/); }
    finally { await release(); }

    assert.equal(f.setupCalls, 0);
  } finally { await f.cleanup(); }
});

test("launchctl adapter inspects PID and provenance and never confuses failures with absence", async () => {
  const args: string[][] = [];
  let exitCode = 113;
  let stdout = "";

  const controller = createNativeServiceController({ HOME: "/disposable-home" }, 501, async (command) => {
    args.push(command);

    return { stdout, exitCode };
  });

  assert.deepEqual(await controller.inspect(), { state: "absent" });
  exitCode = 1;
  assert.deepEqual(await controller.inspect(), { state: "unknown" });
  exitCode = 0;
  stdout = "\tpath = /owned.plist\n\tprogram = /owned/run-bun.sh\n\tpid = 4321\n";
  assert.deepEqual(await controller.inspect(), { state: "loaded", pid: 4321, plist: "/owned.plist", program: "/owned/run-bun.sh" });
  await controller.bootstrap("/owned.plist");
  await controller.bootout();
  assert.deepEqual(args.at(-2), ["bootstrap", "gui/501", "/owned.plist"]);
  assert.deepEqual(args.at(-1), ["bootout", `gui/501/${NATIVE_SERVICE_LABEL}`]);
  assert.deepEqual(args[0], ["print", `gui/501/${NATIVE_SERVICE_LABEL}`]);
});

test("failed reconfiguration restores exact private config bytes and permissions", async () => {
  const f = await fixture();

  try {
    await f.install();
    const provider = path.join(f.paths.configDir, "provider.env");
    const model = path.join(f.paths.configDir, "model-selection.json");
    const before = await Promise.all([provider, model].map((file) => readFile(file)));
    await chmod(f.paths.configDir, 0o750);
    await chmod(provider, 0o640);
    f.bootstrapMode = "waiting";

    const dependencies = { ...f.dependencies, hasConfiguration: async () => false, setup: async (env: NodeJS.ProcessEnv) => {
      await saveDirectProviderConfig({ provider: "openai", baseURL: "https://new.invalid/v1", model: "new-model", apiKey: "replacement-private-secret", timeoutMs: 45000 }, env);
      await saveModelSelection(env.HERDR_PLUGIN_CONFIG_DIR!, { ...selection, model: "new-model" });

      return { saved: true, selection };
    } };

    await assert.rejects(nativeInstall("install", { env: f.env, sourceRoot: f.versions[1]! }, dependencies), /NATIVE_READY_TIMEOUT_MS/);
    assert.deepEqual(await Promise.all([provider, model].map((file) => readFile(file))), before);
    assert.deepEqual(f.activatedProviders.at(-1), before[0], "rollback restores private configuration before restarting the prior service");
    assert.equal((await stat(provider)).mode & 0o777, 0o640);
    assert.equal((await stat(f.paths.configDir)).mode & 0o777, 0o750);
    assert.equal(await readlink(f.paths.current), f.versions[0]);
  } finally { await f.cleanup(); }
});

test("uninstall bootout failure restores the previous loaded activation", async () => {
  const f = await fixture();

  try {
    await f.install();
    const before = await readFile(f.paths.activation);

    const controller: NativeServiceController = { ...f.controller, bootout: async () => {
      await f.controller.bootout();
      throw new Error("injected launchctl bootout failure after stopping");
    } };

    await assert.rejects(nativeInstall("uninstall", { env: f.env }, { ...f.dependencies, controller }), /previous activation restored/);
    assert.deepEqual(await readFile(f.paths.activation), before);
    assert.equal(f.process.state, "loaded");
    assert.equal(await fileExists(f.paths.wrapper), true);
    assert.equal(await readlink(f.paths.current), f.versions[0]);
  } finally { await f.cleanup(); }
});

test("owned metadata never authorizes stopping a different loaded program", async () => {
  const f = await fixture();

  try {
    await f.install();
    f.process = { state: "loaded", pid: 4444, plist: f.paths.plist, program: "/unrelated/replacement" };
    const before = f.calls.length;
    await assert.rejects(f.install(f.versions[1]), /unrelated LaunchAgent/);
    await assert.rejects(nativeInstall("uninstall", { env: f.env }, f.dependencies), /unrelated LaunchAgent/);
    assert.equal(f.calls.slice(before).includes("bootout"), false);
  } finally { await f.cleanup(); }
});

test("redirected config and runtime directories are refused without touching their contents", async () => {
  for (const target of ["configDir", "runtimeDir"] as const) {
    const f = await fixture();

    try {
      const unrelated = path.join(f.root, "unrelated-directory");
      await mkdir(unrelated);
      await writeFile(path.join(unrelated, "preserve"), "user content");
      await mkdir(path.dirname(f.paths[target]), { recursive: true });
      await symlink(unrelated, f.paths[target]);
      await assert.rejects(f.install(), /must not be a symlink/);
      assert.equal(await readFile(path.join(unrelated, "preserve"), "utf8"), "user content");
      assert.equal(f.calls.includes("bootstrap"), false);
      assert.equal(f.process.state, "absent");
    } finally { await f.cleanup(); }
  }
});

test("installed wrapper dispatches status through the runner with a clean environment", async () => {
  const f = await fixture();
  const configDir = path.join(f.root, "private config 'quoted'");

  try {
    await f.install(f.versions[0], configDir);
    const entry = path.join(f.versions[0]!, "src/native-install.ts");
    const module = path.resolve(import.meta.dir, "../src/native-install.ts");
    await writeFile(entry, `import { nativeInstallMain } from ${JSON.stringify(module)};
const activation = await Bun.file(${JSON.stringify(f.paths.activation)}).json();
const health = await Bun.file(${JSON.stringify(path.join(f.paths.runtimeDir, "status.json"))}).json();
const controller = { inspect: async () => ({state:'loaded',pid:health.pid,plist:${JSON.stringify(f.paths.plist)},program:activation.sourceRoot+'/src/run-bun.sh'}), bootstrap: async () => {throw Error('forbidden')}, bootout: async () => {throw Error('forbidden')} };
const result = await nativeInstallMain(process.argv.slice(2), {env:process.env}, {controller,platform:'darwin'});
console.log(JSON.stringify({result, appHome:process.env.HERDR_APP_HOME, key:process.env.SMART_RENAME_API_KEY, daemon:process.env.HERDR_TAB_ID, sourceRoot:process.env.HERDR_PLUGIN_ROOT}));
`);

    const child = Bun.spawn([f.paths.wrapper, "status"], {
      env: { HOME: "/must-not-inherit", SMART_RENAME_API_KEY: "child-inherited-secret", HERDR_TAB_ID: "unrelated-daemon-tab" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });

    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(code, 0, stderr);
    const output = JSON.parse(stdout);
    assert.equal(output.result.installed, true);
    assert.equal(output.result.service, "running");
    assert.equal(output.result.configDir, configDir);
    assert.equal(output.appHome, f.env.HERDR_APP_HOME);
    assert.equal(output.sourceRoot, f.versions[0]);
    assert.equal(output.key, undefined);
    assert.equal(output.daemon, undefined);
    assert.equal(stderr, "");
    assert.equal(await fileExists(f.invoked), false);
  } finally { await f.cleanup(); }
});

async function legacyConfiguration(env: NodeJS.ProcessEnv, files: readonly (readonly [string, string])[]): Promise<string> {
  const source = path.join(env.XDG_CONFIG_HOME ?? path.join(env.HOME!, ".config"), "herdr/plugins/config/tab-smart-rename");
  await mkdir(source, { recursive: true, mode: 0o750 });
  await chmod(source, 0o750);

  for (const [name, content] of files) {
    await writeFile(path.join(source, name), content);
    await chmod(path.join(source, name), 0o640);
  }

  return source;
}

const legacyPiSelection = JSON.stringify({ version: 1, source: "pi", provider: "fixture-provider", model: "fixture-model" });

test("native install imports daemon selection, custom policy and provider file without changing their source", async () => {
  const f = await fixture();

  const files = [
    ["model-selection.json", legacyPiSelection],
    ["naming-prompt.md", "Use the fixture naming policy, not the bundled default."],
    ["provider.env", "SMART_RENAME_API_KEY=dead-imported-secret\n"],
  ] as const;

  const source = await legacyConfiguration(f.env, files);
  await writeFile(path.join(source, "unrelated.json"), "never import this file");

  try {
    const result = await f.install();
    assert.deepEqual(result.imported, files.map(([name]) => name));
    assert.equal(f.setupCalls, 0, "valid Pi selection does not fall back to the dead Direct key or interactive setup");
    assert.equal(JSON.parse(await readFile(path.join(f.paths.configDir, "model-selection.json"), "utf8")).source, "pi");

    for (const [name, content] of files) {
      assert.equal(await readFile(path.join(f.paths.configDir, name), "utf8"), content);
      assert.equal(await readFile(path.join(source, name), "utf8"), content);
      assert.equal((await stat(path.join(f.paths.configDir, name))).mode & 0o777, 0o600);
      assert.equal((await stat(path.join(source, name))).mode & 0o777, 0o640);
    }

    assert.equal((await stat(f.paths.configDir)).mode & 0o777, 0o700);
    assert.equal((await stat(source)).mode & 0o777, 0o750);
    assert.equal(await fileExists(path.join(f.paths.configDir, "unrelated.json")), false);
    assert.equal(JSON.stringify(result).includes("dead-imported-secret"), false);
    assert.equal(JSON.stringify(result).includes("fixture naming policy"), false);
    assert.equal(await fileExists(f.invoked), false);
  } finally { await f.cleanup(); }
});

for (const configHome of ["xdg", "home"] as const) {
  test(`native import accepts a selection-only daemon config using ${configHome} defaults`, async () => {
    const f = await fixture();
    const env: NodeJS.ProcessEnv = { ...f.env };

    if (configHome === "home") delete env.XDG_CONFIG_HOME;
    const source = await legacyConfiguration(env, [["model-selection.json", legacyPiSelection]]);

    try {
      const result = await nativeInstall("install", { env, sourceRoot: f.versions[0]! }, f.dependencies);
      assert.deepEqual(result.imported, ["model-selection.json"]);
      assert.equal(f.setupCalls, 0);
      assert.equal(await readFile(path.join(source, "model-selection.json"), "utf8"), legacyPiSelection);
      assert.equal(await fileExists(path.join(result.configDir!, "provider.env")), false);
      assert.equal(await fileExists(path.join(result.configDir!, "naming-prompt.md")), false);
    } finally { await f.cleanup(); }
  });
}

test("valid native configuration and its policy take precedence over daemon import", async () => {
  const f = await fixture();

  try {
    await f.install();
    const provider = await readFile(path.join(f.paths.configDir, "provider.env"));
    await writeFile(path.join(f.paths.configDir, "naming-prompt.md"), "Keep the native policy");
    await legacyConfiguration(f.env, [["model-selection.json", legacyPiSelection], ["naming-prompt.md", "Old daemon policy"]]);
    const result = await f.install(f.versions[1]);
    assert.equal(result.imported, undefined);
    assert.equal(f.setupCalls, 1);
    assert.deepEqual(await readFile(path.join(f.paths.configDir, "provider.env")), provider);
    assert.deepEqual(JSON.parse(await readFile(path.join(f.paths.configDir, "model-selection.json"), "utf8")), selection);
    assert.equal(await readFile(path.join(f.paths.configDir, "naming-prompt.md"), "utf8"), "Keep the native policy");
  } finally { await f.cleanup(); }
});

test("cancelling setup after an invalid import restores an absent native directory and leaves daemon files intact", async () => {
  const f = await fixture();
  const source = await legacyConfiguration(f.env, [["model-selection.json", "invalid JSON"], ["naming-prompt.md", "Imported policy"]]);

  try {
    const result = await nativeInstall("install", { env: f.env, sourceRoot: f.versions[0]! }, {
      ...f.dependencies, setup: async () => ({ saved: false }),
    });

    assert.equal(result.cancelled, true);
    assert.equal(await fileExists(f.paths.configDir), false);
    assert.equal(await readFile(path.join(source, "model-selection.json"), "utf8"), "invalid JSON");
    assert.equal(await readFile(path.join(source, "naming-prompt.md"), "utf8"), "Imported policy");
    assert.equal(f.calls.includes("bootstrap"), false);
  } finally { await f.cleanup(); }
});

test("failed activation rolls back imported policy, selection and provider bytes and modes", async () => {
  const f = await fixture();
  const names = ["model-selection.json", "naming-prompt.md", "provider.env"];
  await mkdir(f.paths.configDir, { recursive: true });
  await chmod(f.paths.configDir, 0o750);

  for (const name of names) {
    await writeFile(path.join(f.paths.configDir, name), `original ${name}`);
    await chmod(path.join(f.paths.configDir, name), 0o640);
  }

  const source = await legacyConfiguration(f.env, [["model-selection.json", legacyPiSelection], ["naming-prompt.md", "Imported policy"], ["provider.env", "SMART_RENAME_API_KEY=dead-imported-secret"]]);
  f.bootstrapMode = "waiting";

  try {
    await assert.rejects(f.install(), /NATIVE_READY_TIMEOUT_MS/);
    assert.equal(f.setupCalls, 0);

    for (const name of names) {
      assert.equal(await readFile(path.join(f.paths.configDir, name), "utf8"), `original ${name}`);
      assert.equal((await stat(path.join(f.paths.configDir, name))).mode & 0o777, 0o640);
    }

    assert.equal((await stat(f.paths.configDir)).mode & 0o777, 0o750);
    assert.equal(await readFile(path.join(source, "naming-prompt.md"), "utf8"), "Imported policy");
    assert.equal(f.process.state, "absent");
  } finally { await f.cleanup(); }
});

test("ready supervisor with offline or blocked targets activates and status exposes a sanitized last error", async () => {
  const f = await fixture();
  f.targetCounts = { active: 0, waiting: 1, blocked: 1 };
  f.lastError = { targetId: "work/tb2", reason: "\u001b[31mHTTP 401 API_KEY='private-status-secret'\u001b[0m", timestamp: new Date().toISOString() };

  try {
    const installed = await f.install();
    assert.equal(installed.installed, true);
    assert.equal(installed.health?.state, "ready");
    assert.deepEqual(installed.health.targets, { active: 0, waiting: 1, blocked: 1 });
    const status = await nativeInstallMain(["status"], { env: f.env }, f.dependencies);
    assert.equal(status.health?.lastError?.targetId, "work/tb2");
    assert.match(status.health?.lastError?.reason ?? "", /HTTP 401/);
    assert.equal(JSON.stringify(status).includes("private-status-secret"), false);
    assert.equal(status.health?.lastError?.reason.includes("\u001b"), false);
    assert.ok(Number.isFinite(Date.parse(status.health?.lastError?.timestamp ?? "")));
  } finally { await f.cleanup(); }
});

test("status accepts the earlier minimal version-one worker health schema", async () => {
  const f = await fixture();

  try {
    await f.install();
    const file = path.join(f.paths.runtimeDir, "status.json");
    const health = JSON.parse(await readFile(file, "utf8"));
    delete health.targets;
    delete health.lastError;
    await writeFile(file, JSON.stringify(health));
    const result = await nativeInstall("status", { env: f.env }, f.dependencies);
    assert.equal(result.service, "running");
    assert.equal(result.health?.state, "ready");
  } finally { await f.cleanup(); }
});

// The in-app trigger: one key in herdr-app's keys.json opens a headless owned mod.
import { z } from "zod";
import { installTrigger, renderTriggerMod, TRIGGER_ACTION, TRIGGER_KEY, triggerModDirectory } from "../src/native-trigger.ts";

const KeysFileSchema = z.record(z.string(), z.record(z.string(), z.string()));

type KeysFile = z.infer<typeof KeysFileSchema>;

async function keysFixture(f: Awaited<ReturnType<typeof fixture>>, keys: KeysFile | null) {
  await mkdir(f.env.HERDR_APP_HOME, { recursive: true });
  const file = path.join(f.env.HERDR_APP_HOME, "keys.json");

  if (keys) await writeFile(file, `${JSON.stringify(keys, null, 2)}\n`);

  return { file, read: async () => KeysFileSchema.parse(JSON.parse(await readFile(file, "utf8"))) };
}

test("install writes the trigger mod and binds a free key once, with a backup of the person's keys", async () => {
  const f = await fixture();

  try {
    const keys = await keysFixture(f, { global: { "cmd-t": "tab.new" }, terminal: { "cmd-c": "terminal.copy" } });
    const first = await f.install();
    assert.equal(first.trigger?.mod, "installed");
    assert.equal(first.trigger?.key, "added");
    assert.ok(first.trigger?.backup?.startsWith(`${keys.file}.bak-`));
    assert.deepEqual(await keys.read(), { global: { "cmd-t": "tab.new", [TRIGGER_KEY]: TRIGGER_ACTION }, terminal: { "cmd-c": "terminal.copy" } });
    assert.equal(await readFile(first.trigger!.backup!, "utf8"), `${JSON.stringify({ global: { "cmd-t": "tab.new" }, terminal: { "cmd-c": "terminal.copy" } }, null, 2)}\n`);
    const directory = triggerModDirectory(f.env.HERDR_APP_HOME);
    const activation = await f.activation();
    const rendered = renderTriggerMod(activation, f.paths);
    assert.equal(await readFile(path.join(directory, "main.js"), "utf8"), rendered["main.js"]);
    assert.equal(await readFile(path.join(directory, "mod.json"), "utf8"), rendered["mod.json"]);
    assert.ok(rendered["main.js"].includes(`"${path.join(f.paths.current, "src/run-bun.sh")}"`));
    assert.ok(rendered["main.js"].includes(`"--config-dir",${JSON.stringify(f.paths.configDir)}`));
    assert.ok(rendered["main.js"].includes(`"HERDR_APP_HOME=${f.env.HERDR_APP_HOME}"`));
    assert.equal(rendered["main.js"].includes("secret"), false);
    assert.equal(rendered["main.js"].includes("daemon-tab-do-not-inherit"), false);

    const second = await f.install(f.versions[1]);
    assert.equal(second.trigger?.key, "already-bound");
    assert.equal(second.trigger?.backup, undefined);
    assert.equal((await readdir(f.env.HERDR_APP_HOME)).filter((name) => name.startsWith("keys.json.bak-")).length, 1);
    assert.equal(await fileExists(f.invoked), false);
  } finally { await f.cleanup(); }
});

test("install never overwrites a person's binding of the trigger key or a foreign mod of the same name", async () => {
  const f = await fixture();

  try {
    const keys = await keysFixture(f, { global: { [TRIGGER_KEY]: "pane.split:right" } });
    const directory = triggerModDirectory(f.env.HERDR_APP_HOME);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "main.js"), "export default class Mine {}\n");
    const result = await f.install();
    assert.equal(result.installed, true);
    assert.equal(result.trigger?.key, "colliding");
    assert.equal(result.trigger?.mod, "foreign");
    assert.deepEqual(await keys.read(), { global: { [TRIGGER_KEY]: "pane.split:right" } });
    assert.equal(await readFile(path.join(directory, "main.js"), "utf8"), "export default class Mine {}\n");
    assert.equal(await fileExists(path.join(directory, "mod.json")), false);
    assert.equal((await readdir(f.env.HERDR_APP_HOME)).some((name) => name.startsWith("keys.json.bak-")), false);

    const removed = await nativeInstall("uninstall", { env: f.env }, f.dependencies);
    assert.equal(removed.trigger?.mod, "foreign");
    assert.equal(removed.trigger?.key, "absent");
    assert.deepEqual(await keys.read(), { global: { [TRIGGER_KEY]: "pane.split:right" } });
    assert.equal(await readFile(path.join(directory, "main.js"), "utf8"), "export default class Mine {}\n");
  } finally { await f.cleanup(); }
});

test("install reports a missing or invalid keys file and still writes the mod", async () => {
  const f = await fixture();

  try {
    await keysFixture(f, null);
    const missing = await f.install();
    assert.equal(missing.trigger?.key, "no-keys-file");
    assert.equal(missing.trigger?.mod, "installed");
    assert.equal(await fileExists(path.join(triggerModDirectory(f.env.HERDR_APP_HOME), "main.js")), true);
    await writeFile(path.join(f.env.HERDR_APP_HOME, "keys.json"), "{ not json");
    const invalid = await installTrigger(f.env.HERDR_APP_HOME, await f.activation(), f.paths, { now: () => 0 });
    assert.equal(invalid.key, "invalid-keys-file");
    assert.equal(await readFile(path.join(f.env.HERDR_APP_HOME, "keys.json"), "utf8"), "{ not json");
  } finally { await f.cleanup(); }
});

test("uninstall removes the owned mod and only our key binding, keeping every other key", async () => {
  const f = await fixture();

  try {
    const keys = await keysFixture(f, { global: { "cmd-t": "tab.new" }, "layout:mine": { "cmd-shift-s": "mine.settle" } });
    await f.install();
    assert.equal((await keys.read()).global![TRIGGER_KEY], TRIGGER_ACTION);
    const result = await nativeInstall("uninstall", { env: f.env }, f.dependencies);
    assert.equal(result.trigger?.mod, "removed");
    assert.equal(result.trigger?.key, "removed");
    assert.ok(result.trigger?.backup);
    assert.deepEqual(await keys.read(), { global: { "cmd-t": "tab.new" }, "layout:mine": { "cmd-shift-s": "mine.settle" } });
    assert.equal(await fileExists(triggerModDirectory(f.env.HERDR_APP_HOME)), false);
    assert.equal((await readdir(f.env.HERDR_APP_HOME)).filter((name) => name.startsWith("keys.json.bak-")).length, 2);

    const again = await nativeInstall("uninstall", { env: f.env }, f.dependencies);
    assert.equal(again.trigger?.mod, "absent");
    assert.equal(again.trigger?.key, "absent");
  } finally { await f.cleanup(); }
});
