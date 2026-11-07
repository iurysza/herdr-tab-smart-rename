import { z } from "zod";
import { fingerprint, type PaneContext } from "./domain.ts";
import { gitRoot, run, type HerdrPane, type HerdrSnapshot } from "./herdr.ts";
import { ModelSourceNamer } from "./model-namer.ts";
import { type Namer } from "./provider.ts";
import { AutoNameService, type ServiceDependencies } from "./service.ts";
import { statePaths } from "./storage.ts";
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

const RpcResponse = z.object({
  id: z.literal("smart-rename-native"),
  result: LayoutDocument,
});

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

export class HerdrAppClient {
  readonly #tab: string;
  readonly #command: NativeCommand;
  readonly #app: string;
  readonly #core: string;
  readonly #env: NodeJS.ProcessEnv;

  constructor(tab: string, env: NodeJS.ProcessEnv = process.env, command = nativeCommand(env)) {
    if (!/^tb[\da-f]+$/.test(tab))
      throw new Error("An explicit local native tab ID is required; remote and daemon IDs are not supported");
    this.#tab = tab;
    this.#command = command;
    this.#env = env;
    this.#app = env.HERDR_APP_BIN_PATH || "herdr-app";
    this.#core = env.HC_BIN_PATH || "hc";
  }

  async snapshot(): Promise<HerdrSnapshot> {
    const [topology, status, document] = await Promise.all([
      this.#command(this.#app, ["ls"]).then((text) => Topology.parse(JSON.parse(text))),
      this.#command(this.#app, ["status"]).then((text) => WindowStatus.parse(JSON.parse(text))),
      this.#command(this.#core, ["connect"], `${JSON.stringify({
        jsonrpc: "2.0",
        id: "smart-rename-native",
        method: "doc.get",
        params: { name: "herdr-app" },
      })}\n`).then((text) => RpcResponse.parse(JSON.parse(text)).result),
    ]);

    const snap: HerdrSnapshot = { workspaces: [], tabs: [], panes: [], layouts: [] };

    for (const space of topology.spaces) {
      const tab = space.tabs.find((item) => item.id === this.#tab);

      if (!tab) continue;

      if (space.machine !== null) throw new Error("Remote native spaces are not supported");

      const stored = document.value.spaces.find((item) => item.id === space.id)
        ?.tabs.find((item) => item.id === tab.id);

      if (!stored || (stored.name && stored.name !== tab.name))
        throw new Error("Native layout changed or hc targets a different core; retry with matching HERDR_APP_HOME and HC_SESSION");
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
        const facts = await this.facts(placement.terminal);

        if (facts.state !== "live") continue;

        if (facts.labels["herdr.tab"] !== tab.id || facts.labels["herdr.space"] !== space.id)
          throw new Error("Native terminal labels do not match the selected space and tab; check HC_SESSION");

        const pane: HerdrPane = {
          pane_id: placement.pane,
          terminal_id: placement.terminal,
          tab_id: tab.id,
          workspace_id: space.id,
          label: "",
          cwd: facts.cwd,
          foreground_cwd: facts.foreground?.cwd || facts.cwd,
          // Include terminal creation and Pi's session label in stale-result identity.
          agent_session: { kind: "id", value: fingerprint([facts.address, facts.created_ms, facts.labels["pi.session"], facts.foreground?.argv]) },
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

    return snap;
  }

  private async facts(terminal: string) {
    const facts = TerminalFacts.parse(JSON.parse(await this.#command(this.#core, ["get", terminal, "--json"])));

    if (facts.address !== terminal) throw new Error("Native core returned a different terminal");

    return facts;
  }

  async context(pane: HerdrPane, focused: boolean): Promise<PaneContext> {
    if (!pane.terminal_id) throw new Error("Native pane has no terminal address");
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

  async rename(kind: "workspace" | "tab" | "pane", id: string, label: string): Promise<void> {
    if (kind !== "tab" || id !== this.#tab)
      throw new Error("Native naming can only write its explicitly selected tab");
    z.object({ ok: z.literal(true) }).parse(JSON.parse(
      await this.#command(this.#app, ["do", "tab.rename", JSON.stringify({ id, name: label })]),
    ));
  }

  dependencies(): ServiceDependencies {
    return {
      snapshot: () => this.snapshot(),
      gitRoot,
      focusedPaneContext: (pane) => this.context(pane, true),
      siblingPaneContext: (pane) => this.context(pane, false),
      rename: (kind, id, label) => this.rename(kind, id, label),
    };
  }
}

export interface NativeServiceOptions {
  tab: string;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  namer?: Namer;
  dryRun?: boolean;
  command?: NativeCommand;
}

export function createNativeService(options: NativeServiceOptions): AutoNameService {
  const env = options.env ?? process.env;
  const client = new HerdrAppClient(options.tab, env, options.command);
  const paths = statePaths(options.stateDir);

  return new AutoNameService({
    stateFile: paths.state,
    stateLock: paths.stateLock,
    env,
    namer: options.namer ?? new ModelSourceNamer(env),
    dryRun: options.dryRun ?? false,
    dependencies: client.dependencies(),
    targetKinds: ["tab"],
    transcriptAgents: [],
    // No daemon progress marker: an API label must not become the user's native name.
  });
}
