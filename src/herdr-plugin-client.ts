import { z } from "zod";
import { sanitizeText } from "./text.ts";

export const SMART_RENAME_PLUGIN_ID = "tab-smart-rename";

export const HERDR_PLUGIN_LOG_LIMIT = 200;

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<CommandResult>;

export interface InstalledPlugin {
  readonly id: string;
  readonly root: string;
  readonly source: { readonly kind: string; readonly owner?: string; readonly repo?: string; readonly ref?: string };
  readonly commit?: string;
}

export interface ActionFailure {
  readonly action: string;
  readonly logId: string;
  readonly message: string;
}

interface ServerTarget {
  socket?: string;
  session?: string | null;
}

const ServerSchema = z.looseObject({
  running: z.boolean(),
  compatible: z.boolean().optional(),
  version: z.string().optional(),
  socket: z.string().optional(),
  session: z.string().nullable().optional(),
});

const PluginSchema = z.looseObject({
  id: z.string().optional(),
  plugin_id: z.string().optional(),
  plugin_root: z.string().optional(),
  root: z.string().optional(),
  source: z
    .looseObject({
      kind: z.string(),
      owner: z.string().optional(),
      repo: z.string().optional(),
      ref: z.string().optional(),
      requested_ref: z.string().optional(),
      commit: z.string().optional(),
      resolved_commit: z.string().optional(),
    })
    .optional(),
  commit: z.string().optional(),
  resolved_commit: z.string().optional(),
});

const PluginListSchema = z.object({
  result: z.object({ plugins: z.array(PluginSchema) }),
});

const InvocationSchema = z.object({
  result: z.looseObject({ log: z.looseObject({ log_id: z.string().min(1) }) }),
});

const LogSchema = z.looseObject({
  log_id: z.string(),
  action_id: z.string().optional(),
  status: z.string(),
  exit_code: z.number().int().nullable().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
});

const LogListSchema = z.object({ result: z.object({ logs: z.array(LogSchema) }) });

type PluginLog = z.infer<typeof LogSchema>;

export interface HerdrPluginClientOptions {
  readonly run?: CommandRunner;
  readonly env?: NodeJS.ProcessEnv;
  readonly pluginId?: string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  readonly actionTimeoutMs?: number;
}

const defaultRun: CommandRunner = async (command, args, env) => {
  const child = Bun.spawn([command, ...args], {
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
};

export class HerdrPluginClient {
  readonly #run: CommandRunner;
  readonly #env: NodeJS.ProcessEnv;
  readonly #pluginId: string;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;
  readonly #pollIntervalMs: number;
  readonly #actionTimeoutMs: number;

  constructor({
    run = defaultRun,
    env = process.env,
    pluginId = SMART_RENAME_PLUGIN_ID,
    sleep = (milliseconds) => Bun.sleep(milliseconds),
    now = () => Date.now(),
    pollIntervalMs = 100,
    actionTimeoutMs = 120_000,
  }: HerdrPluginClientOptions = {}) {
    this.#run = run;
    this.#env = env;
    this.#pluginId = pluginId;
    this.#sleep = sleep;
    this.#now = now;
    this.#pollIntervalMs = pollIntervalMs;
    this.#actionTimeoutMs = actionTimeoutMs;
  }

  async preflightServer(): Promise<ServerTarget> {
    const server = await this.#json("status server", ["status", "server", "--json"], ServerSchema);

    if (!server.success) throw new Error("Herdr server status returned invalid JSON");

    if (!server.data.running) throw new Error("Herdr target server is not running");

    if (server.data.compatible === false) {
      throw new Error(`Herdr target server is incompatible${server.data.version ? ` (${server.data.version})` : ""}`);
    }

    const target: ServerTarget = {};

    if (server.data.socket) target.socket = server.data.socket;

    if (server.data.session !== undefined) target.session = server.data.session;

    return target;
  }

  async installedPlugin(): Promise<InstalledPlugin | null> {
    const list = await this.#json("plugin list", [
      "plugin",
      "list",
      "--plugin",
      this.#pluginId,
      "--json",
    ], PluginListSchema);

    if (!list.success) throw new Error("Herdr plugin list returned invalid JSON");

    const plugin = list.data.result.plugins.find(
      (item) => (item.plugin_id ?? item.id) === this.#pluginId,
    );

    if (!plugin) return null;
    const root = plugin.plugin_root ?? plugin.root;

    if (!root) throw new Error(`Herdr did not report a managed root for ${this.#pluginId}`);
    const source = plugin.source ?? { kind: "unknown" };
    const ref = source.requested_ref ?? source.ref;

    const commit =
      plugin.resolved_commit ?? plugin.commit ?? source.resolved_commit ?? source.commit;

    const sourceDetails = { kind: source.kind };

    if (source.owner) Object.assign(sourceDetails, { owner: source.owner });

    if (source.repo) Object.assign(sourceDetails, { repo: source.repo });

    if (ref) Object.assign(sourceDetails, { ref });

    const installed = {
      id: plugin.plugin_id ?? plugin.id ?? this.#pluginId,
      root,
      source: sourceDetails,
    };

    return commit !== undefined ? { ...installed, commit } : installed;
  }

  async configDirectory(): Promise<string> {
    const result = await this.#command("plugin config-dir", [
      "plugin",
      "config-dir",
      this.#pluginId,
    ]);

    const directory = result.stdout.trim();

    if (!directory) throw new Error(`Herdr did not report a config directory for ${this.#pluginId}`);

    return directory;
  }

  async invoke(action: string): Promise<string> {
    const invocation = await this.#json(`plugin action ${action}`, [
      "plugin",
      "action",
      "invoke",
      action,
      "--plugin",
      this.#pluginId,
    ], InvocationSchema);

    if (!invocation.success) {
      throw new Error(`Herdr did not return an action log id for ${action}`);
    }

    return invocation.data.result.log.log_id;
  }

  async waitForAction(action: string, logId: string): Promise<void> {
    const startedAt = this.#now();

    while (true) {
      const logs = await this.#logs();
      const log = logs.find((item) => item.log_id === logId);

      if (log) {
        if (log.status === "succeeded" && log.exit_code === 0) return;

        if (log.status !== "running" && log.status !== "queued") {
          throw this.#actionFailure(action, logId, log);
        }
      }

      const elapsed = this.#now() - startedAt;

      if (elapsed >= this.#actionTimeoutMs) {
        throw new Error(
          `Smart Rename action timeout: action=${action}; log_id=${logId}; requested_log_limit=${HERDR_PLUGIN_LOG_LIMIT}; elapsed_ms=${elapsed}; configured_timeout_ms=${this.#actionTimeoutMs}; requested_operation=herdr plugin action invoke ${action} --plugin ${this.#pluginId}`,
        );
      }

      await this.#sleep(this.#pollIntervalMs);
    }
  }

  async invokeAndWait(action: string): Promise<void> {
    await this.waitForAction(action, await this.invoke(action));
  }

  async #logs(): Promise<readonly PluginLog[]> {
    const logs = await this.#json("plugin log list", [
      "plugin",
      "log",
      "list",
      "--plugin",
      this.#pluginId,
      "--limit",
      String(HERDR_PLUGIN_LOG_LIMIT),
    ], LogListSchema);

    if (!logs.success) throw new Error("Herdr plugin log list returned invalid JSON");

    return logs.data.result.logs;
  }

  #actionFailure(action: string, logId: string, log: PluginLog): Error {
    let details = "";

    for (const value of [log.stderr, log.stdout, log.error]) {
      if (!value?.trim()) continue;
      details = sanitizeText(value).trim();

      if (details) break;
    }

    const message = details || `status ${log.status}${log.exit_code === undefined || log.exit_code === null ? "" : `, exit ${log.exit_code}`}`;

    return new Error(`Smart Rename ${action} action log ${logId} failed: ${message}`);
  }

  async #json<T extends z.ZodType>(
    label: string,
    args: readonly string[],
    schema: T,
  ): Promise<z.ZodSafeParseResult<z.output<T>>> {
    const result = await this.#command(label, args);
    let value: unknown;

    try {
      value = JSON.parse(result.stdout);
    } catch {
      throw new Error(`${label} returned invalid JSON`);
    }

    return schema.safeParse(value);
  }

  async #command(label: string, args: readonly string[]): Promise<CommandResult> {
    const result = await this.#run(this.#env.HERDR_BIN_PATH || "herdr", args, this.#env);

    if (result.exitCode !== 0) {
      const detail = sanitizeText(result.stderr || result.stdout).trim();
      throw new Error(`${label} failed${detail ? `: ${detail}` : ` (exit ${result.exitCode})`}`);
    }

    return result;
  }
}
