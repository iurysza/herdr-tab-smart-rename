import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { fingerprint, type PaneContext } from "./domain.ts";
import { gitRoot, run, type HerdrPane, type HerdrSnapshot } from "./herdr.ts";
import { ModelSourceNamer } from "./model-namer.ts";
import { type Namer } from "./provider.ts";
import { AutoNameService, type ServiceDependencies } from "./service.ts";
import { ensurePrivateDir, statePaths } from "./storage.ts";
import { boundedText } from "./text.ts";

const TerminalPlacement = z.object({
  terminal: z.string(),
  pane: z.string(),
  app: z.string().nullable(),
  status: z.string().nullable(),
});

const NativeTab = z.object({
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
  terminals: z.array(TerminalPlacement),
});

const Topology = z.object({
  spaces: z.array(z.object({
    id: z.string(),
    name: z.string(),
    folder: z.string(),
    machine: z.string().nullable(),
    tabs: z.array(NativeTab),
  })),
});

const LayoutDocument = z.object({
  version: z.number().int().nonnegative(),
  value: z.object({
    spaces: z.array(z.object({
      id: z.string(),
      tabs: z.array(z.object({ id: z.string(), name: z.string() })),
    })),
  }),
});

type Layout = z.infer<typeof LayoutDocument>;

const WindowStatus = z.object({
  tab: z.string().nullable(),
  focused_pane: z.string().nullable(),
});

const TerminalFacts = z.object({
  address: z.string(),
  state: z.enum(["live", "finished"]),
  cwd: z.string(),
  title: z.string(),
  created_ms: z.number(),
  labels: z.record(z.string(), z.string()),
  foreground: z.object({
    name: z.string(),
    argv: z.array(z.string()),
    cwd: z.string(),
  }).nullable().optional(),
});

const RPC_ID = "smart-rename-native";

const RpcResponse = z.union([
  z.object({ id: z.literal(RPC_ID), result: LayoutDocument }),
  z.object({ id: z.literal(RPC_ID), error: z.object({
    message: z.string(),
    data: z.object({ kind: z.string().optional() }).nullable().optional(),
  }) }),
]);

const MachineList = z.object({
  machines: z.array(z.object({
    name: z.string(),
    id: z.string(),
    state: z.string(),
    session: z.string().nullable().optional(),
  })),
});

// Same 10-second tripwire as the command runner, applied to write confirmation.
const CONFIRM_TIMEOUT_MS = 10_000;

export type NativeFailureKind = "unavailable" | "machine_unknown" | "needs_update" | "core_changed";

// Typed so watchers can retry transient availability and layout lag.
export class NativeTargetError extends Error {
  readonly kind: NativeFailureKind;

  constructor(kind: NativeFailureKind, message: string) {
    super(message);
    this.name = "NativeTargetError";
    this.kind = kind;
  }
}

export function isTransientNativeError(error: Error): boolean {
  return error instanceof NativeTargetError && error.kind === "unavailable";
}

export interface NativeTarget {
  // Full app tab ID: used for app, service, state and writes.
  readonly id: string;
  // Null for the local core.
  readonly machine: string | null;
  // Machine-local ID: used only for raw document and label comparisons.
  readonly bare: string;
}

const LOCAL_TAB = /^tb[\da-f]+$/;

const REMOTE_TAB = /^([A-Za-z\d][\w.-]*)\/(tb[\da-f]+)$/;

export function parseNativeTarget(id: string): NativeTarget {
  if (LOCAL_TAB.test(id)) return { id, machine: null, bare: id };
  const match = REMOTE_TAB.exec(id);

  // The app reports local spaces as machine "local"; a "local/" prefix is ambiguous.
  if (match && match[1] !== "local") return { id, machine: match[1]!, bare: match[2]! };

  throw new Error("An explicit native tab ID (tbN or machine/tbN) is required; daemon IDs are not supported");
}

// Remote core identity pinned for one service lifetime. Null means the local core.
export type NativeBinding = {
  readonly machine: string;
  readonly core: string;
  readonly session: string | null;
} | null;

function spaceMachine(machine: string | null): string | null {
  return machine === null || machine === "local" ? null : machine;
}

export type NativeCommand = (
  command: string,
  args: string[],
  input?: string,
) => Promise<string>;

export function nativeCommand(env: NodeJS.ProcessEnv): NativeCommand {
  return async (command, args, input) => {
    if (input === undefined) return run(command, args, { env });

    const child = Bun.spawn([command, ...args], {
      env,
      stdin: Buffer.from(input),
      stdout: "pipe",
      stderr: "pipe",
    });

    // Match the existing Herdr adapter's 10-second command tripwire.
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10_000);

    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      if (timedOut) throw new Error(`${command} exceeded the 10000ms command timeout`);

      if (code !== 0) throw new Error(stderr.trim() || `${command} exited ${code}`);

      return stdout.trim();
    } finally {
      clearTimeout(timer);
    }
  };
}

// Discovery reads topology only. Per-target snapshots still verify core identity,
// document ownership and terminal labels before collecting context or writing.
export async function discoverNativeTargets(env: NodeJS.ProcessEnv, command = nativeCommand(env)): Promise<NativeTarget[]> {
  const topology = Topology.parse(JSON.parse(await command(env.HERDR_APP_BIN_PATH || "herdr-app", ["ls"])));
  const targets = new Map<string, NativeTarget>();

  for (const space of topology.spaces) {
    for (const tab of space.tabs) {
      let target: NativeTarget;

      try { target = parseNativeTarget(tab.id); } catch { continue; }

      if (target.machine === spaceMachine(space.machine)) targets.set(target.id, target);
    }
  }

  return [...targets.values()];
}

export class HerdrAppClient {
  readonly target: NativeTarget;
  readonly #command: NativeCommand;
  readonly #app: string;
  readonly #core: string;
  readonly #env: NodeJS.ProcessEnv;
  #binding: NativeBinding | undefined;

  constructor(tab: string, env: NodeJS.ProcessEnv = process.env, command = nativeCommand(env)) {
    this.target = parseNativeTarget(tab);
    this.#command = command;
    this.#env = env;
    this.#app = env.HERDR_APP_BIN_PATH || "herdr-app";
    this.#core = env.HC_BIN_PATH || "hc";

    if (this.target.machine === null) this.#binding = null;
  }

  // Resolves the remote core once; later reads and writes must reach the same core.
  async bind(): Promise<NativeBinding> {
    if (this.#binding !== undefined) return this.#binding;
    const machine = await this.machine();

    this.#binding = { machine: machine.name, core: machine.id, session: machine.session ?? null };

    return this.#binding;
  }

  private async machine() {
    const name = this.target.machine;
    const list = MachineList.parse(JSON.parse(await this.#command(this.#core, ["machine", "ls", "--json"])));
    const entry = list.machines.find((item) => item.name === name);

    if (!entry) throw new NativeTargetError("machine_unknown", `Remote machine ${name} is not known to the local core`);

    return entry;
  }

  private async verify(binding: NativeBinding): Promise<void> {
    if (!binding) return;
    const entry = await this.machine();

    if (entry.id !== binding.core || (entry.session ?? null) !== binding.session)
      throw new NativeTargetError("core_changed", `Remote machine ${binding.machine} now points to a different core or session; restart to rebind`);

    if (entry.state !== "connected")
      throw new NativeTargetError("unavailable", `Remote machine ${binding.machine} is ${entry.state}; will retry`);
  }

  private bareId(id: string): string {
    const machine = this.target.machine;

    if (machine === null) {
      if (id.includes("/")) throw new Error("Native ID belongs to a different machine than the selected tab");

      return id;
    }

    if (!id.startsWith(`${machine}/`)) throw new Error("Native ID belongs to a different machine than the selected tab");

    return id.slice(machine.length + 1);
  }

  private async document(binding: NativeBinding): Promise<Layout> {
    const params = binding ? { name: "herdr-app", on: binding.machine } : { name: "herdr-app" };

    const response = RpcResponse.parse(JSON.parse(await this.#command(this.#core, ["connect"], `${JSON.stringify({
      jsonrpc: "2.0", id: RPC_ID, method: "doc.get", params,
    })}\n`)));

    if ("result" in response) return response.result;
    const kind = response.error.data?.kind;
    const message = `Native layout unavailable: ${response.error.message}`;

    if (kind === "unavailable") throw new NativeTargetError("unavailable", message);

    if (kind === "needs_update") throw new NativeTargetError("needs_update", `${message}; update herdr-core on the remote machine`);

    if (kind === "machine_unknown") throw new NativeTargetError("machine_unknown", message);

    throw new Error(message);
  }

  private storedTab(document: Layout) {
    return document.value.spaces.flatMap((space) => space.tabs).find((tab) => tab.id === this.target.bare);
  }

  private mismatch(): Error {
    // App acknowledgement can precede local or remote document persistence.
    // Retrying does not permit writes until the document and labels match.
    return new NativeTargetError("unavailable", this.target.machine === null
      ? "Native layout changed or hc targets a different core; retry with matching HERDR_APP_HOME and HC_SESSION"
      : "Remote native layout does not match the app yet; will retry");
  }

  async snapshot(): Promise<HerdrSnapshot> {
    const binding = await this.bind();

    await this.verify(binding);

    const [topology, status, document] = await Promise.all([
      this.#command(this.#app, ["ls"]).then((text) => Topology.parse(JSON.parse(text))),
      this.#command(this.#app, ["status"]).then((text) => WindowStatus.parse(JSON.parse(text))),
      this.document(binding),
    ]);

    const snap: HerdrSnapshot = { workspaces: [], tabs: [], panes: [], layouts: [] };

    for (const space of topology.spaces) {
      const tab = space.tabs.find((item) => item.id === this.target.id);

      if (!tab) continue;

      if (spaceMachine(space.machine) !== this.target.machine)
        throw new Error("Native space belongs to a different machine than the selected tab");
      const spaceId = this.bareId(space.id);

      const stored = document.value.spaces.find((item) => item.id === spaceId)
        ?.tabs.find((item) => item.id === this.target.bare);

      if (!stored || (stored.name && stored.name !== tab.name)) throw this.mismatch();
      snap.workspaces.push({
        workspace_id: space.id,
        label: space.name,
        number: 1,
        cwd: space.folder,
      });
      snap.tabs.push({
        tab_id: tab.id,
        workspace_id: space.id,
        label: stored.name,
        named: stored.name !== "",
        number: space.tabs.indexOf(tab) + 1,
      });

      for (const placement of tab.terminals) {
        this.bareId(placement.pane);
        this.bareId(placement.terminal);
        const facts = await this.facts(placement.terminal);

        if (facts.state !== "live") continue;

        // Core labels are machine-local even when the address is qualified.
        if (facts.labels["herdr.tab"] !== this.target.bare || facts.labels["herdr.space"] !== spaceId)
          throw new Error("Native terminal labels do not match the selected space and tab; check HC_SESSION");

        const source = [facts.address, facts.created_ms, facts.labels["pi.session"], facts.foreground?.argv];

        const pane: HerdrPane = {
          pane_id: placement.pane,
          terminal_id: placement.terminal,
          tab_id: tab.id,
          workspace_id: space.id,
          label: "",
          cwd: facts.cwd,
          foreground_cwd: facts.foreground?.cwd || facts.cwd,
          // Hashed stale-result identity: terminal creation, Pi session, argv and remote core.
          agent_session: { kind: "id", value: fingerprint(binding ? [binding.core, binding.session, ...source] : source) },
        };

        if (placement.app) pane.agent = placement.app;

        if (placement.status) pane.agent_status = placement.status;
        snap.panes.push(pane);
      }

      const focused = snap.panes.find((pane) => pane.pane_id === status.focused_pane);

      snap.layouts.push({ tab_id: tab.id });

      if (focused) snap.layouts[0]!.focused_pane_id = focused.pane_id;

      if (status.tab === tab.id) snap.focused_tab_id = tab.id;

      if (focused) snap.focused_pane_id = focused.pane_id;
    }

    // App/core downtime or layout lag is not evidence that a tab closed.
    if (snap.tabs.length === 0 && this.storedTab(document)) throw this.mismatch();

    // The alias must still name the same core after every read.
    await this.verify(binding);

    return snap;
  }

  private async facts(terminal: string) {
    let text: string;

    try {
      text = await this.#command(this.#core, ["get", terminal, "--json"]);
    } catch (error) {
      // The remote can disconnect after snapshot verification but before this read.
      // Retry only when fresh broker metadata confirms the same core is unavailable.
      await this.verify(await this.bind());
      throw error;
    }

    const facts = TerminalFacts.parse(JSON.parse(text));

    if (facts.address !== terminal) throw new Error("Native core returned a different terminal");

    return facts;
  }

  async context(pane: HerdrPane, focused: boolean): Promise<PaneContext> {
    if (!pane.terminal_id) throw new Error("Native pane has no terminal address");
    await this.verify(await this.bind());
    const facts = await this.facts(pane.terminal_id);
    const foreground = facts.foreground;
    let recentOutput = "";

    if (focused) {
      const read = z.object({ text: z.string() }).parse(JSON.parse(
        await this.#command(this.#core, ["read", pane.terminal_id, "--json", "--lines", "0"]),
      ));

      // Same context budget as the existing daemon adapter. Never scroll a live agent.
      recentOutput = boundedText(read.text.split("\n").slice(-12).join("\n"), 1_000, this.#env.HOME);
    }

    return {
      focused,
      label: boundedText(facts.title, 80, this.#env.HOME),
      process: foreground ? {
        name: boundedText(foreground.name, 80, this.#env.HOME),
        command: boundedText(foreground.argv.join(" "), 500, this.#env.HOME),
        cwd: boundedText(foreground.cwd, 200, this.#env.HOME),
      } : null,
      recentOutput,
      userMessages: [],
    };
  }

  async rename(kind: "workspace" | "tab" | "pane", id: string, label: string, expectedName?: string): ReturnType<ServiceDependencies["rename"]> {
    if (kind !== "tab" || id !== this.target.id)
      throw new Error("Native naming can only write its explicitly selected tab");
    const binding = await this.bind();

    // Never write through an alias that was remapped during inference.
    await this.verify(binding);
    const before = this.storedTab(await this.document(binding))?.name;

    await this.verify(binding);

    if (before === undefined) return { status: "skipped", reason: "native tab closed before write" };

    if (expectedName === undefined || before !== expectedName)
      return { status: "skipped", reason: "native tab name changed before write" };

    z.object({ ok: z.literal(true) }).parse(JSON.parse(
      await this.#command(this.#app, ["do", "tab.rename", JSON.stringify({ id, name: label })]),
    ));
    await this.confirm(binding, before, label);
  }

  // App acknowledgement precedes layout persistence. Read back; never re-issue the write.
  private async confirm(binding: NativeBinding, before: string | undefined, label: string): Promise<void> {
    const deadline = performance.now() + CONFIRM_TIMEOUT_MS;

    for (let delay = 25; ; delay = Math.min(delay * 2, 500)) {
      await this.verify(binding);
      const name = this.storedTab(await this.document(binding))?.name;

      if (name === label) return this.verify(binding);

      if (name === undefined || name !== before)
        throw new Error("Native rename was not confirmed: the layout changed during the write; keeping the newer state");

      if (performance.now() >= deadline)
        throw new NativeTargetError("unavailable", `Native rename was acknowledged but not persisted within ${CONFIRM_TIMEOUT_MS}ms`);
      await Bun.sleep(delay);
    }
  }

  dependencies(): ServiceDependencies {
    return {
      snapshot: () => this.snapshot(),
      // Remote cwd values name remote paths. Never inspect them on this machine.
      gitRoot: this.target.machine === null ? gitRoot : async () => null,
      focusedPaneContext: (pane) => this.context(pane, true),
      siblingPaneContext: (pane) => this.context(pane, false),
      rename: (kind, id, label, _env, expectedName) => this.rename(kind, id, label, expectedName),
    };
  }
}

export function nativeAppHome(env: NodeJS.ProcessEnv): string {
  return env.HERDR_APP_HOME ?? path.join(env.HOME ?? os.homedir(), ".config/herdr-app");
}

// Local targets use the base directory unchanged. Remote targets nest by
// permanent core identity, remote session, app home, local HC session and tab.
export function nativeStateDir(base: string, target: NativeTarget, binding: NativeBinding, env: NodeJS.ProcessEnv): string {
  if (!binding) return base;

  return path.join(base, "remote", fingerprint([
    nativeAppHome(env), env.HC_SESSION ?? "default", binding.core, binding.session, target.id,
  ]).slice(0, 24));
}

export interface NativeServiceOptions {
  tab: string;
  // Base directory. Remote targets resolve to a nested core-scoped directory.
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  namer?: Namer;
  dryRun?: boolean;
  command?: NativeCommand;
}

export interface NativeService {
  readonly service: AutoNameService;
  readonly target: NativeTarget;
  readonly stateDir: string;
}

export async function createNativeService(options: NativeServiceOptions): Promise<NativeService> {
  const env = options.env ?? process.env;
  const client = new HerdrAppClient(options.tab, env, options.command);
  const binding = await client.bind();
  const stateDir = nativeStateDir(options.stateDir, client.target, binding, env);
  const paths = statePaths(stateDir);

  if (!options.dryRun) await ensurePrivateDir(stateDir);

  return {
    target: client.target,
    stateDir,
    service: new AutoNameService({
      stateFile: paths.state,
      stateLock: paths.stateLock,
      env,
      namer: options.namer ?? new ModelSourceNamer(env),
      dryRun: options.dryRun ?? false,
      dependencies: client.dependencies(),
      targetKinds: ["tab"],
      transcriptAgents: [],
      // No daemon progress marker: an API label must not become the user's native name.
    }),
  };
}
