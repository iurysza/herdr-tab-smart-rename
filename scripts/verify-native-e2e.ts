#!/usr/bin/env bun
import assert from "node:assert/strict";
import { createServer, connect, type Socket } from "node:net";
import { chmod, copyFile, cp, mkdir, mkdtemp, open, readFile, readlink, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export function nativeE2eSandbox(root: string, hostHome: string, registryProxyPort?: number): string {
  if (registryProxyPort !== undefined) assert.ok(Number.isInteger(registryProxyPort) && registryProxyPort > 0 && registryProxyPort <= 65535);

  return `(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))
(deny file-read* (subpath ${JSON.stringify(hostHome)}))
(allow file-read* (subpath ${JSON.stringify(root)}))
(allow file-read-metadata)
(deny process-exec (literal "/bin/launchctl"))
(deny file-read* (literal "/dev/tty"))
(deny network*)
${registryProxyPort ? `(allow network-outbound (remote ip "localhost:${registryProxyPort}"))` : ""}
`;
}

export function isNativeRegistryConnect(request: string): boolean {
  return request === "CONNECT registry.npmjs.org:443 HTTP/1.1" || request === "CONNECT registry.npmjs.org:443 HTTP/1.0";
}

async function registryTunnel(evidence: string) {
  const sockets = new Set<Socket>();
  let connections = 0;

  const server = createServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    client.setTimeout(30_000, () => client.destroy());
    let header = Buffer.alloc(0);

    const negotiate = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf("\r\n\r\n");

      if (header.length > 8192) { client.destroy();

 return; }

      if (end < 0) return;
      client.removeListener("data", negotiate);
      const request = header.subarray(0, end).toString("ascii").split("\r\n")[0];

      if (!request || !isNativeRegistryConnect(request)) {
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");

        return;
      }

      connections++;
      const upstream = connect(443, "registry.npmjs.org");
      sockets.add(upstream);
      upstream.once("close", () => { sockets.delete(upstream); client.destroy(); });
      client.once("close", () => upstream.destroy());
      upstream.on("error", () => { client.destroy(); upstream.destroy(); });
      upstream.setTimeout(30_000, () => upstream.destroy());
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const remainder = header.subarray(end + 4);

        if (remainder.length) upstream.write(remainder);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    };

    client.on("data", negotiate);
  });

  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = z.object({ port: z.number().int().min(1).max(65535) }).parse(server.address());

  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await writeFile(path.join(evidence, "registry-tunnel.json"), JSON.stringify({ authority: "registry.npmjs.org:443", connections }));
    },
  };
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface NativeE2eResult {
  evidence: string;
  installedRoot: string;
  workerPid: number;
  sdk: { agent: string; ai: string };
  dependencyInstall: "real-frozen-production";
  network: "registry-only-install-actor";
  providerCalls: 0;
  uninstallKeptConfig: true;
  workerStopped: true;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function executable(file: string, content: string): Promise<void> {
  await writeFile(file, content, { mode: 0o700 });
  await chmod(file, 0o700);
}

async function readOptional(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function verifyNativeE2e(destination: string): Promise<NativeE2eResult> {
  assert.equal(process.platform, "darwin", "This verifier requires macOS sandbox-exec");
  const project = await realpath(path.resolve(import.meta.dir, ".."));
  await mkdir(destination, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(destination, "run-")));
  const bin = path.join(root, "bin");
  const checkout = path.join(root, "checkout");
  const home = path.join(root, "home");
  const runtime = path.join(bin, "bun-runtime");
  const helpers = path.join(root, "helpers");

  for (const directory of [bin, helpers, home, path.join(root, "tmp"), checkout]) await mkdir(directory, { recursive: true, mode: 0o700 });
  await copyFile(await realpath(process.execPath), runtime);
  await chmod(runtime, 0o700);

  for (const relative of ["src", "assets", "package.json", "bun.lock", "provider.env.example", "docs/naming-policy.md", "installer/install.sh", "scripts/package-native.ts", "scripts/render-installer.ts"]) {
    await mkdir(path.dirname(path.join(checkout, relative)), { recursive: true });
    await cp(path.join(project, relative), path.join(checkout, relative), { recursive: true });
  }

  const lock = await readFile(path.join(checkout, "bun.lock"), "utf8");

  for (const match of lock.matchAll(/https?:\/\/[^\s"']+/g)) assert.equal(new URL(match[0]).hostname, "registry.npmjs.org", "Only npm registry URLs are permitted in the dependency lock");
  const head = Bun.spawn(["git", "-C", project, "rev-parse", "HEAD"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const commit = (await new Response(head.stdout).text()).trim();
  assert.equal(await head.exited, 0);
  assert.match(commit, /^[a-f\d]{40}$/);
  await executable(path.join(bin, "git"), `#!/bin/sh\n[ "$1" = '-C' ] && [ "$2" = ${quote(checkout)} ] && [ "$3" = rev-parse ] && [ "$4" = HEAD ] || exit 99\nprintf '%s\\n' '${commit}'\n`);
  const data = path.join(home, ".local/share/herdr-tab-smart-rename/native");
  const installedRoot = path.join(data, "versions", commit);
  const config = path.join(home, ".config/herdr-tab-smart-rename/native");
  const workerState = path.join(home, ".local/state/herdr-tab-smart-rename/native-service");
  await mkdir(config, { recursive: true, mode: 0o700 });
  await writeFile(path.join(config, "model-selection.json"), JSON.stringify({ version: 1, source: "pi", provider: "fixture", model: "fixture" }), { mode: 0o600 });
  await writeFile(path.join(config, "naming-prompt.md"), "Name only this synthetic integration task.", { mode: 0o600 });
  await writeFile(path.join(root, "tab.json"), JSON.stringify({ name: "" }));

  const env = {
    HOME: home, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: path.join(root, "tmp"),
    BUN_PATH: path.join(bin, "bun"), BUN_INSTALL_CACHE_DIR: path.join(root, "npm-cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"), XDG_CACHE_HOME: path.join(home, ".cache"),
    PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"),
    HERDR_APP_BIN_PATH: path.join(bin, "herdr-app"), HC_BIN_PATH: path.join(bin, "hc"),
    HERDR_APP_HOME: path.join(home, "native-app"), HC_SESSION: "native-e2e",
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org", npm_config_registry: "https://registry.npmjs.org",
    TERM: "dumb",
  };

  const constants = `const root=${JSON.stringify(root)}; const runtime=${JSON.stringify(runtime)}; const installed=${JSON.stringify(installedRoot)};`;
  const request = path.join(root, "dependency-request.json");
  const response = path.join(root, "dependency-response.json");
  await executable(path.join(helpers, "dependency.ts"), `${constants}
await Bun.write(root+"/dependency-request.json",JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(2)}));
const deadline=Date.now()+300000;
for(;;){ const file=Bun.file(root+"/dependency-response.json"); if(await file.exists()){const result=await file.json();process.exit(result.exitCode)} if(Date.now()>deadline)throw Error("Dependency actor exceeded 300000ms");await Bun.sleep(50); }
`);
  await executable(path.join(helpers, "cli.ts"), `${constants}
import { appendFile } from "node:fs/promises";
const [entry,...args]=process.argv.slice(2);
if(!entry||!entry.includes("/versions/")&&!entry.includes("/current/"))throw Error("Unexpected native CLI path");
const {nativeInstallMain}=await import(entry);
const {createNativeServiceController,NativeInstallError}=await import(installed+"/src/native-service.ts");
const controller=createNativeServiceController(process.env,process.getuid(),async(argv)=>{
 const child=Bun.spawn([runtime,root+"/helpers/launchctl.ts",...argv],{env:process.env,stdin:"ignore",stdout:"pipe",stderr:"pipe"});
 const [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 if(stderr)await appendFile(root+"/fake-launchctl.stderr.log",stderr);
 return {stdout,exitCode};
});
await appendFile(root+"/cli.jsonl",JSON.stringify({entry,args})+"\\n");
try{ console.log(JSON.stringify(await nativeInstallMain(args,{env:process.env},{controller}))); }
catch(error){console.error(error instanceof NativeInstallError?error.message:"Installed native CLI failed");process.exitCode=1;}
`);
  await executable(path.join(helpers, "worker.ts"), `${constants}
import { appendFile, realpath, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const [entry,...args]=process.argv.slice(2);
if(entry!==installed+"/src/native-worker.ts")throw Error("Unexpected worker entry");
const {runNativeWorker,nativeWorkerOptions}=await import(entry);
const {ModelSourceNamer}=await import(installed+"/src/model-namer.ts");
const agent=await realpath(Bun.resolveSync("@earendil-works/pi-coding-agent",installed+"/src"));
const ai=await realpath(Bun.resolveSync("@earendil-works/pi-ai",installed+"/src"));
const modules=await realpath(installed+"/node_modules");
if(!agent.startsWith(modules+"/")||!ai.startsWith(modules+"/"))throw Error("SDK escaped installed dependency tree");
const [agentSdk,aiSdk]=await Promise.all([import(agent),import(ai)]);
if(typeof agentSdk.ModelRuntime?.create!=="function"||typeof aiSdk.getSupportedThinkingLevels!=="function")throw Error("Installed Pi SDK exports do not match the adapter");
await writeFile(root+"/sdk-import.json",JSON.stringify({agent,ai,importOnly:true,runtimeCreated:false,providerCalls:0}));
const fake={id:"pi",listProviders:async()=>[],listModels:async()=>[],listProfiles:async()=>[],validate:async()=>{},complete:async()=>{await appendFile(root+"/fake-model.jsonl",JSON.stringify({source:"fake-pi",providerCalls:0})+"\\n");return JSON.stringify({tab:"Verify Native Integration",reason:"synthetic task"})},close:async()=>{await appendFile(root+"/fake-model-close.jsonl","closed\\n")}};
const options=nativeWorkerOptions(args,process.env);
const namer=new ModelSourceNamer({...process.env,HERDR_PLUGIN_CONFIG_DIR:options.configDir},async()=>fake,{suggest:async()=>{throw Error("Direct source is forbidden in this fixture")}});
const controller=new AbortController();const stop=()=>controller.abort();process.once("SIGTERM",stop);process.once("SIGINT",stop);
const nonce=randomUUID();await writeFile(root+"/worker-owner.json",JSON.stringify({pid:process.pid,nonce,entry}));
let stopping=false;
const control=setInterval(async()=>{const request=await Bun.file(root+"/worker-stop.json").json().catch(()=>null);if(!stopping&&request?.pid===process.pid&&request?.nonce===nonce){stopping=true;clearInterval(control);process.kill(process.pid,"SIGTERM")}},25);
try{await runNativeWorker({...options,namer},controller.signal)}finally{clearInterval(control);await writeFile(root+"/worker-closed.json",JSON.stringify({pid:process.pid,nonce}))}

`);
  await executable(path.join(bin, "bun"), `#!/bin/sh
set -eu
case "\${1:-}" in
  install) exec ${quote(runtime)} ${quote(path.join(helpers, "dependency.ts"))} "$@" ;;
  */native-install.ts) entry="$1"; shift; exec ${quote(runtime)} ${quote(path.join(helpers, "cli.ts"))} "$entry" "$@" ;;
  */native-worker.ts) entry="$1"; shift; exec ${quote(runtime)} ${quote(path.join(helpers, "worker.ts"))} "$entry" "$@" ;;
  *) exec ${quote(runtime)} "$@" ;;
esac
`);
  await executable(path.join(helpers, "launchctl.ts"), `${constants}
import {appendFile,open,readFile,rm,writeFile} from "node:fs/promises";
const args=process.argv.slice(2);await appendFile(root+"/launchctl.jsonl",JSON.stringify(args)+"\\n");
const file=root+"/job.json";
let job;try{job=JSON.parse(await readFile(file,"utf8"))}catch(error){if(error.code!=="ENOENT")throw error}
if(args[0]==="print"){
 if(!job)process.exit(113);
 console.log("path = "+job.plist+"\\nprogram = "+job.program+"\\npid = "+job.pid);process.exit(0);
}
if(args[0]==="bootstrap"){
 if(job)throw Error("Duplicate fake service");
 const plist=args[2];const xml=await readFile(plist,"utf8");
 const decode=(text)=>text.replaceAll("&quot;",'"').replaceAll("&apos;","'").replaceAll("&lt;","<").replaceAll("&gt;",">").replaceAll("&amp;","&");
 const array=xml.match(/<key>ProgramArguments<\\/key><array>(.*?)<\\/array>/s)?.[1];
 const argv=[...array.matchAll(/<string>(.*?)<\\/string>/gs)].map(match=>decode(match[1]));
 if(argv[0]!==installed+"/src/run-bun.sh"||argv[1]!==installed+"/src/native-worker.ts")throw Error("LaunchAgent left installed payload");
 const dictionary=xml.match(/<key>EnvironmentVariables<\\/key><dict>(.*?)<\\/dict>/s)?.[1];
 const env=Object.fromEntries([...dictionary.matchAll(/<key>(.*?)<\\/key><string>(.*?)<\\/string>/gs)].map(match=>[decode(match[1]),decode(match[2])]));
 const log=await open(root+"/worker.log","a",0o600);
 const child=Bun.spawn(argv,{cwd:installed,env,stdin:"ignore",stdout:log.fd,stderr:log.fd,detached:true});child.unref();await log.close();
 await writeFile(file,JSON.stringify({pid:child.pid,plist,program:argv[0]}));process.exit(0);
}
if(args[0]==="bootout"){
 if(!job)process.exit(113);
 if(job.program!==installed+"/src/run-bun.sh"||!Number.isSafeInteger(job.pid)||job.pid<=1)throw Error("Refusing unowned fake worker");
 const owner=JSON.parse(await readFile(root+"/worker-owner.json","utf8"));
 if(owner.pid!==job.pid||owner.entry!==installed+"/src/native-worker.ts"||typeof owner.nonce!=="string")throw Error("Refusing unrelated fake worker ownership");
 await writeFile(root+"/worker-stop.json",JSON.stringify({pid:owner.pid,nonce:owner.nonce}));
 const deadline=Date.now()+15000;
 for(;;){const closed=await Bun.file(root+"/worker-closed.json").json().catch(()=>null);if(closed?.pid===owner.pid&&closed?.nonce===owner.nonce)break;if(Date.now()>deadline)throw Error("Fake worker shutdown exceeded 15000ms");await Bun.sleep(25)}
 await rm(file);process.exit(0);
}
throw Error("Unexpected fake launchctl operation");
`);

  const fakeCommands = `${constants}
import {appendFile,readFile,writeFile} from "node:fs/promises";
const args=process.argv.slice(2);const tool=import.meta.file;await appendFile(root+"/native-commands.jsonl",JSON.stringify({tool,args})+"\\n");
const tab=JSON.parse(await readFile(root+"/tab.json","utf8"));
if(tool==="herdr-app"){
 if(args[0]==="ls")console.log(JSON.stringify({spaces:[{id:"sp1",name:"Fixture",folder:"",machine:null,tabs:[{id:"tb1",name:tab.name||"1",active:true,terminals:[{terminal:"t1",pane:"p1",app:"pi",status:"working"}]}]}]}));
 else if(args[0]==="status")console.log(JSON.stringify({tab:"tb1",focused_pane:"p1"}));
 else if(args[0]==="do"&&args[1]==="tab.rename"){const value=JSON.parse(args[2]);if(value.id!=="tb1")throw Error("Wrong fixture tab");await writeFile(root+"/tab.json",JSON.stringify({name:value.name}));console.log('{"ok":true}');}
 else throw Error("Unexpected fake app command");
}else if(tool==="hc"){
 if(args[0]==="events"){if(JSON.stringify(args)!==JSON.stringify(["events","--json"]))throw Error("Filtered events");console.log(JSON.stringify({type:"snapshot"}));setInterval(()=>console.log(JSON.stringify({type:"heartbeat"})),1000);}
 else if(args[0]==="connect"){const request=JSON.parse(await Bun.stdin.text());if(request.method!=="doc.get"||request.params.on)throw Error("Unexpected core RPC");console.log(JSON.stringify({id:"smart-rename-native",result:{version:1,value:{spaces:[{id:"sp1",tabs:[{id:"tb1",name:tab.name}]}]}}}));}
 else if(args[0]==="get"){if(args[1]!=="t1")throw Error("Wrong fixture terminal");console.log(JSON.stringify({address:"t1",state:"live",cwd:"",title:"Fixture Terminal",created_ms:1,labels:{"herdr.tab":"tb1","herdr.space":"sp1"},foreground:{name:"python",argv:["python","fixture.py"],cwd:""}}));}
 else if(args[0]==="read")console.log(JSON.stringify({text:"Synthetic integration task, not user terminal output"}));
 else throw Error("Unexpected fake core command");
}else throw Error("Unexpected tool");
`;

  for (const command of ["herdr-app", "hc"]) await executable(path.join(bin, command), `#!${runtime}\n${fakeCommands}`);
  await executable(path.join(bin, "herdr"), `#!/bin/sh\nprintf forbidden >> ${quote(path.join(root, "forbidden.log"))}\nexit 99\n`);
  const offlineProfile = path.join(root, "offline.sb");
  await writeFile(offlineProfile, nativeE2eSandbox(root, await realpath(os.homedir())));

  const run = async (argv: string[], profile = offlineProfile, cwd = checkout, timeoutMs = 30_000, extraEnv: NodeJS.ProcessEnv = {}): Promise<CommandResult> => {
    const child = Bun.spawn(["/usr/bin/sandbox-exec", "-f", profile, ...argv], { env: { ...env, ...extraEnv }, cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), timeoutMs);

    try {
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

      return { stdout, stderr, exitCode };
    } finally { clearTimeout(timer); }
  };

  const probe = path.join(helpers, "probe.ts");
  await writeFile(probe, `import {readFile,writeFile} from "node:fs/promises";
for(const [operation,file] of [[readFile,${JSON.stringify(path.join(os.homedir(), "AGENTS.md"))}],[writeFile,${JSON.stringify(path.join(project, ".native-e2e-write-probe"))}]]){try{await operation(file,"utf8");throw Error("Containment probe unexpectedly succeeded")}catch(error){if(!["EPERM","EACCES"].includes(error.code))throw error}}
console.log("Containment probe passed");`);
  const probed = await run([runtime, probe]);
  await writeFile(path.join(root, "containment.log"), JSON.stringify(probed, null, 2));
  assert.equal(probed.exitCode, 0, probed.stderr);
  const stdout = await open(path.join(root, "install.stdout.log"), "w", 0o600);
  const stderr = await open(path.join(root, "install.stderr.log"), "w", 0o600);

  const installer = Bun.spawn(["/usr/bin/sandbox-exec", "-f", offlineProfile, "/bin/sh", path.join(checkout, "installer/install.sh"), "--native"], {
    env, cwd: checkout, stdin: "ignore", stdout: stdout.fd, stderr: stderr.fd,
  });

  await stdout.close();
  await stderr.close();
  let exitCode: number | undefined;
  void installer.exited.then((value) => { exitCode = value; });
  const deadline = Date.now() + 330_000;
  let dependencyInstalled = false;
  let summary: NativeE2eResult | undefined;
  let cleanupFailed = false;

  try {
    while (exitCode === undefined) {
      if (!dependencyInstalled && await readOptional(request)) {
        const work = JSON.parse((await readOptional(request))!);
        assert.deepEqual(work.argv, ["install", "--production", "--frozen-lockfile", "--ignore-scripts"]);
        assert.ok(work.cwd.startsWith(path.join(data, "versions", `.stage.${commit}.`)));
        assert.equal(path.dirname(work.cwd), path.join(data, "versions"));
        assert.equal(await realpath(work.cwd), work.cwd);
        assert.equal((await stat(work.cwd)).isDirectory(), true);
        console.log("Installing production dependencies from the npm registry inside the disposable home");
        const tunnel = await registryTunnel(root);

        try {
          const networkProfile = path.join(root, "registry-install.sb");
          await writeFile(networkProfile, nativeE2eSandbox(root, await realpath(os.homedir()), tunnel.port));
          const proxy = `http://127.0.0.1:${tunnel.port}`;
          const installed = await run([runtime, ...work.argv], networkProfile, work.cwd, 300_000, { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NO_PROXY: "" });
          await writeFile(path.join(root, "dependency-install.stdout.log"), installed.stdout);
          await writeFile(path.join(root, "dependency-install.stderr.log"), installed.stderr);
          await writeFile(response, JSON.stringify({ exitCode: installed.exitCode }));
          assert.equal(installed.exitCode, 0, `Production dependency install failed; evidence: ${root}`);
          dependencyInstalled = true;
        } finally { await tunnel.close(); }
      }

      if (Date.now() > deadline) throw new Error("Native integration exceeded the 330000ms startup limit");
      await Bun.sleep(50);
    }

    assert.equal(exitCode, 0, `Installer failed; evidence: ${root}`);
    assert.equal(dependencyInstalled, true);
    const activation = JSON.parse(await readFile(path.join(data, "activation.json"), "utf8"));
    assert.equal(activation.sourceRoot, installedRoot);
    const health = JSON.parse(await readFile(path.join(workerState, "status.json"), "utf8"));
    assert.equal(health.state, "ready");
    const sdk = JSON.parse(await readFile(path.join(root, "sdk-import.json"), "utf8"));
    assert.equal(sdk.importOnly, true);
    assert.equal(sdk.runtimeCreated, false);
    const namingDeadline = Date.now() + 15_000;

    while (JSON.parse(await readFile(path.join(root, "tab.json"), "utf8")).name !== "Verify Native Integration") {
      if (Date.now() > namingDeadline) throw new Error("Installed worker did not rename the fixture tab within 15000ms");
      await Bun.sleep(25);
    }

    assert.ok(await readOptional(path.join(root, "fake-model.jsonl")));
    const wrapper = path.join(home, ".local/bin/smart-rename-native");
    const inspected = await run([wrapper, "status"]);
    await writeFile(path.join(root, "status.json"), inspected.stdout);
    await writeFile(path.join(root, "status.stderr.log"), inspected.stderr);
    assert.equal(inspected.exitCode, 0, `Installed status failed; evidence: ${root}`);
    const status = JSON.parse(inspected.stdout);
    assert.equal(status.service, "running");
    assert.equal(status.health.state, "ready");
    assert.equal(status.health.pid, health.pid);
    const before = await readFile(path.join(config, "model-selection.json"));
    const promptBefore = await readFile(path.join(config, "naming-prompt.md"));
    const removed = await run(["/bin/sh", path.join(checkout, "installer/install.sh"), "--native", "--uninstall"]);
    await writeFile(path.join(root, "uninstall.stdout.log"), removed.stdout);
    await writeFile(path.join(root, "uninstall.stderr.log"), removed.stderr);
    assert.equal(removed.exitCode, 0, `Native uninstall failed; evidence: ${root}`);
    assert.deepEqual(await readFile(path.join(config, "model-selection.json")), before);
    assert.deepEqual(await readFile(path.join(config, "naming-prompt.md")), promptBefore);
    assert.equal(await readOptional(path.join(root, "job.json")), undefined);
    await assert.rejects(readlink(path.join(data, "current")), { code: "ENOENT" });
    const stopped = JSON.parse(await readFile(path.join(workerState, "status.json"), "utf8"));
    assert.equal(stopped.state, "stopping");
    assert.equal(stopped.managedTabs, 0);
    assert.equal(await readFile(path.join(root, "fake-model-close.jsonl"), "utf8"), "closed\n");
    const shutdownDeadline = Date.now() + 5000;

    for (;;) {
      try { process.kill(health.pid, 0); } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") break;
        throw error;
      }

      if (Date.now() > shutdownDeadline) throw new Error("Owned fixture worker remained alive after uninstall for 5000ms");
      await Bun.sleep(25);
    }

    assert.equal(await readOptional(wrapper), undefined);
    assert.equal(await readOptional(path.join(data, "activation.json")), undefined);
    assert.equal(await readOptional(path.join(home, "Library/LaunchAgents/dev.herdr.tab-smart-rename.native.plist")), undefined);
    assert.equal(await readOptional(path.join(root, "forbidden.log")), undefined);

    summary = {
      evidence: root, installedRoot, workerPid: health.pid, sdk: { agent: sdk.agent, ai: sdk.ai },
      dependencyInstall: "real-frozen-production", network: "registry-only-install-actor", providerCalls: 0, uninstallKeptConfig: true, workerStopped: true,
    };

    await writeFile(path.join(root, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    if (exitCode === undefined) installer.kill();
    await installer.exited;
    const cleanup = await run([runtime, path.join(helpers, "launchctl.ts"), "bootout", `gui/${process.getuid!()}/dev.herdr.tab-smart-rename.native`]);

    if (cleanup.exitCode !== 0 && cleanup.exitCode !== 113) {
      await writeFile(path.join(root, "cleanup-error.log"), cleanup.stderr);
      cleanupFailed = true;
    }
  }

  if (cleanupFailed) throw new Error(`Fixture cleanup failed; evidence: ${root}`);
  assert.ok(summary);
  console.log(`Native end-to-end verification passed: ${root}`);

  return summary;
}

if (import.meta.main) {
  const evidence = process.argv[2] ?? path.join(os.tmpdir(), "smart-rename-native-e2e");
  await verifyNativeE2e(evidence).catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
