#!/usr/bin/env bun
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Host creates one owned test directory. No host cleanup or process matching.
// Tests and their children may write only there. Retain it as test evidence.
if (process.platform !== "darwin") throw new Error("This local test runner requires macOS sandbox-exec.");
const project = await realpath(path.resolve(import.meta.dir, ".."));
const dependencies = await realpath(path.join(project, "node_modules"));
const runRoot = await realpath(await mkdtemp("/tmp/smart-rename-contained-"));
const home = path.join(runRoot, "home");
await mkdir(home);
const harness = process.argv.includes("--harness");
const opencode = harness ? await realpath(path.join(os.homedir(), ".opencode/bin/opencode")) : undefined;
const bin = path.join(runRoot, "bin");
await mkdir(bin);
if (opencode) await symlink(opencode, path.join(bin, "opencode"));
const profile = path.join(runRoot, "test.sb");
const ancestors = new Set<string>();
for (const initial of [project, dependencies, ...(opencode ? [opencode] : [])]) {
  for (let directory = path.dirname(initial); directory !== path.dirname(directory); directory = path.dirname(directory)) ancestors.add(directory);
}
await writeFile(profile, `(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath (param "RUN_ROOT")) (literal "/dev/null") (literal "/dev/tty") (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$"))
(deny file-read* (subpath (param "HOST_HOME")))
(allow file-read* (subpath (param "PROJECT")) (subpath (param "DEPENDENCIES")))
; Bun reads package metadata above a linked node_modules directory.
(allow file-read* (literal ${JSON.stringify(path.join(path.dirname(dependencies), "tsconfig.json"))}) (literal ${JSON.stringify(path.join(path.dirname(dependencies), "package.json"))}))
${opencode ? `(allow file-read* (literal ${JSON.stringify(opencode)}))` : ""}
(allow file-read-metadata)
(allow file-read* ${[...ancestors].map((directory) => `(literal ${JSON.stringify(directory)})`).join(" ")})
(deny network*)
(allow network* (local ip "localhost:*") (remote ip "localhost:*") (local unix-socket (subpath (param "RUN_ROOT"))) (remote unix-socket (subpath (param "RUN_ROOT"))))
`);
const env = {
  PATH: `${bin}:/opt/homebrew/bin:/usr/bin:/bin`,
  HOME: home,
  TMPDIR: runRoot,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_STATE_HOME: path.join(home, ".local/state"),
  XDG_DATA_HOME: path.join(home, ".local/share"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"),
  BUN_INSTALL_CACHE_DIR: path.join(runRoot, "bun-cache"),
  TERM: "xterm-256color",
  ...(harness ? { SMART_RENAME_HARNESS_TEST: "1", OPENCODE_DISABLE_AUTOUPDATE: "true" } : {}),
};
const prefix = ["/usr/bin/sandbox-exec", "-D", `RUN_ROOT=${runRoot}`, "-D", `HOST_HOME=${await realpath(os.homedir())}`, "-D", `PROJECT=${project}`, "-D", `DEPENDENCIES=${dependencies}`, "-f", profile];
const probe = path.join(runRoot, "probe.ts");
await writeFile(probe, `import { writeFile, readFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
if (!process.env.TMPDIR || os.tmpdir() !== process.env.TMPDIR) throw new Error("Disposable TMPDIR did not reach Bun");
await mkdtemp(os.tmpdir() + "/probe-");
// Probe writes use new names. The read target is a known non-secret instruction file.
for (const file of [${JSON.stringify(path.join(project, ".sandbox-write-probe"))}, ${JSON.stringify(path.join(os.homedir(), ".smart-rename-sandbox-probe"))}]) {
  try { await writeFile(file, "unexpected"); throw new Error("Sandbox allowed host write: " + file); }
  catch (error) { if (!["EPERM", "EACCES"].includes(error.code)) throw error; }
}
try { await readFile(${JSON.stringify(path.join(os.homedir(), "AGENTS.md"))}); throw new Error("Sandbox allowed host read"); }
catch (error) { if (!["EPERM", "EACCES"].includes(error.code)) throw error; }
console.log("Containment probe passed: project/home writes and unrelated home reads denied");
`);
console.log(`Test evidence: ${runRoot}`);
async function run(args: string[]): Promise<number> {
  return Bun.spawn([...prefix, "/usr/bin/env", "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`), process.execPath, ...args], { cwd: project, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" }).exited;
}
const probeExit = await run([probe]);
if (probeExit !== 0) process.exit(probeExit);
process.exitCode = await run(process.argv.includes("--lock-check")
  ? ["install", "--dry-run", "--frozen-lockfile", "--ignore-scripts"]
  : ["test", ...process.argv.slice(2).filter((arg) => arg !== "--harness")]);
