import net, { type Socket } from "node:net";
import { z } from "zod";
import { type PaneContext } from "./domain.ts";
import { paneSessionMessages } from "./pi-context.ts";
import { boundedText } from "./text.ts";

const WorkspaceSchema = z.looseObject({
  workspace_id: z.string(),
  label: z.string(),
  number: z.union([z.number(), z.string()]),
  active_tab_id: z.string().optional(),
  cwd: z.string().optional(),
  worktree: z.object({ repo_name: z.string().optional() }).nullable().optional(),
});

const TabSchema = z.looseObject({
  tab_id: z.string(),
  workspace_id: z.string(),
  label: z.string(),
  number: z.union([z.number(), z.string()]),
});

const PaneSchema = z.looseObject({
  pane_id: z.string(),
  tab_id: z.string(),
  workspace_id: z.string(),
  label: z.string().optional(),
  cwd: z.string().optional(),
  foreground_cwd: z.string().optional(),
  agent: z.string().optional(),
  agent_status: z.string().optional(),
  agent_session: z
    .object({ kind: z.string(), value: z.string() })
    .optional(),
});

const LayoutSchema = z.looseObject({
  tab_id: z.string(),
  focused_pane_id: z.string().optional(),
});

const SnapshotSchema = z.object({
  focused_workspace_id: z.string().optional(),
  focused_tab_id: z.string().optional(),
  focused_pane_id: z.string().optional(),
  workspaces: z.array(WorkspaceSchema),
  tabs: z.array(TabSchema),
  panes: z.array(PaneSchema),
  layouts: z.array(LayoutSchema),
});

const SnapshotResponseSchema = z.object({
  result: z.object({ snapshot: SnapshotSchema }),
});

const ProcessResponseSchema = z.object({
  result: z.object({
    process_info: z.object({
      foreground_processes: z
        .array(
          z.looseObject({
            argv0: z.string().optional(),
            name: z.string().optional(),
            cmdline: z.string().optional(),
            argv: z.array(z.string()).optional(),
            cwd: z.string().optional(),
          }),
        )
        .optional(),
    }),
  }),
});

const EventEnvelopeSchema = z.object({
  event: z.string(),
  data: z.looseObject({
    type: z.string().optional(),
    workspace_id: z.string().optional(),
    tab_id: z.string().optional(),
    pane_id: z.string().optional(),
    label: z.string().optional(),
    workspace: z.object({ workspace_id: z.string().optional() }).optional(),
    tab: z.object({ tab_id: z.string().optional() }).optional(),
    pane: z
      .looseObject({
        pane_id: z.string(),
        workspace_id: z.string(),
        tab_id: z.string(),
        label: z.string().nullable().optional(),
      })
      .optional(),
  }),
});

export type HerdrSnapshot = z.infer<typeof SnapshotSchema>;

export type HerdrWorkspace = z.infer<typeof WorkspaceSchema>;

export type HerdrTab = z.infer<typeof TabSchema>;

export type HerdrPane = z.infer<typeof PaneSchema>;

export type HerdrEvent = z.infer<typeof EventEnvelopeSchema>["data"] & {
  eventName: string;
  type: string;
};

const PROGRESS_MARKER = "\u2063";

const PROGRESS_FRAME = "◆";

// Older versions animated through these frames. Still parse them so a label
// left behind by an interrupted run is never mistaken for a manual name.
const LEGACY_PROGRESS_FRAMES = ["◇", "◈", "◆"] as const;

// Returns the label underneath a rename-in-progress marker, or null when the
// label carries no marker.
export function progressBase(label: string): string | null {
  if (!label.startsWith(PROGRESS_MARKER)) return null;
  const rest = label.slice(PROGRESS_MARKER.length);

  const frame = LEGACY_PROGRESS_FRAMES.find((item) => rest.startsWith(item));

  if (!frame) return null;
  const base = rest.slice(frame.length);

  // Herdr may trim the trailing space of a marker on an empty pane label.
  if (!base) return "";

  return base.startsWith(" ") ? base.slice(1) : null;
}

function progressLabel(base: string): string {
  return `${PROGRESS_MARKER}${PROGRESS_FRAME} ${base}`;
}

export const LIFECYCLE_SUBSCRIPTIONS = [
  "workspace.created",
  "workspace.updated",
  "workspace.renamed",
  "workspace.closed",
  "tab.created",
  "tab.renamed",
  "tab.closed",
  "tab.focused",
  "pane.created",
  "pane.updated",
  "pane.closed",
  "pane.focused",
] as const;

interface RunOptions {
  timeout?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

export async function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<string> {
  const child = Bun.spawn([command, ...args], {
    env: options.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });

  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, options.timeout ?? 10_000);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    if (timedOut) throw new Error(`${command} timed out`);

    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `${command} exited ${exitCode}`);
    }

    if (Buffer.byteLength(stdout) > (options.maxBuffer ?? 2 * 1024 * 1024)) {
      throw new Error(`${command} output exceeded buffer`);
    }

    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function herdrJson(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  return JSON.parse(await run(env.HERDR_BIN_PATH || "herdr", args, { env }));
}

export async function snapshot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HerdrSnapshot> {
  return SnapshotResponseSchema.parse(await herdrJson(["api", "snapshot"], env))
    .result.snapshot;
}

export async function rename(
  kind: "workspace" | "tab" | "pane",
  id: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  // Herdr clears a pane label with a flag rather than an empty argument.
  const args =
    kind === "pane" && !label
      ? [kind, "rename", id, "--clear"]
      : [kind, "rename", id, label];

  await run(env.HERDR_BIN_PATH || "herdr", args, { env });
}

export interface ProgressTarget {
  kind: "tab" | "pane";
  id: string;
}

function liveLabel(
  snap: HerdrSnapshot,
  target: ProgressTarget,
): string | undefined {
  if (target.kind === "tab")
    return snap.tabs.find((item) => item.tab_id === target.id)?.label;

  const pane = snap.panes.find((item) => item.pane_id === target.id);

  return pane ? (pane.label ?? "") : undefined;
}

// Shows a static marker on a label while it is being renamed. The returned
// function restores the original label unless something else changed it,
// such as the new name or a manual edit.
export async function beginProgress(
  target: ProgressTarget,
  env: NodeJS.ProcessEnv = process.env,
): Promise<() => Promise<void>> {
  const none = async (): Promise<void> => {};

  try {
    const base = liveLabel(await snapshot(env), target);

    // Another request may already own the marker. Never nest or restore it.
    if (base === undefined || progressBase(base) !== null) return none;

    const marked = progressLabel(base);
    await rename(target.kind, target.id, marked, env);

    return async () => {
      try {
        const current = liveLabel(await snapshot(env), target);

        // Restore only our own marker. Anything else is a newer name, a
        // manual edit, or another process's marker.
        if (current === marked) await rename(target.kind, target.id, base, env);
      } catch {
        // Progress cleanup must not hide the naming result.
      }
    };
  } catch {
    // Progress is cosmetic. Naming continues without it.
    return none;
  }
}

export async function gitRoot(cwd?: string): Promise<string | null> {
  if (!cwd) return null;

  try {
    return await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
}

async function paneRecent(
  paneId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  try {
    return boundedText(
      await run(
        env.HERDR_BIN_PATH || "herdr",
        ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "12"],
        { env },
      ),
      1_000,
    );
  } catch {
    return "";
  }
}

async function paneProcess(
  paneId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PaneContext["process"]> {
  try {
    const data = ProcessResponseSchema.parse(
      await herdrJson(["pane", "process-info", "--pane", paneId], env),
    );

    const item = data.result.process_info.foreground_processes?.[0];

    if (!item) return null;

    return {
      name: boundedText(item.argv0 ?? item.name, 80),
      command: boundedText(item.cmdline ?? item.argv?.join(" ") ?? "", 500),
      cwd: boundedText(item.cwd, 200),
    };
  } catch {
    return null;
  }
}

export async function focusedPaneContext(
  pane: HerdrPane,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PaneContext> {
  const [process, recentOutput, sessionMessages] = await Promise.all([
    paneProcess(pane.pane_id, env),
    paneRecent(pane.pane_id, env),
    paneSessionMessages(pane, env),
  ]);

  return {
    focused: true,
    label: boundedText(pane.label, 80),
    process,
    recentOutput,
    sessionMessages,
    userMessages: [
      ...sessionMessages.origin,
      ...sessionMessages.middle,
      ...sessionMessages.recent,
    ],
  };
}

export async function siblingPaneContext(
  pane: HerdrPane,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PaneContext> {
  return {
    focused: false,
    label: boundedText(pane.label, 80),
    process: await paneProcess(pane.pane_id, env),
    recentOutput: "",
    userMessages: [],
  };
}

export function normalizeHerdrEvent(message: unknown): HerdrEvent | null {
  const envelope = EventEnvelopeSchema.safeParse(message);

  if (!envelope.success) return null;

  return {
    ...envelope.data.data,
    eventName: envelope.data.event,
    type:
      envelope.data.data.type ?? envelope.data.event.replaceAll(".", "_"),
  };
}

export function paneLabelUpdate(
  event: HerdrEvent,
): { paneId: string; label: string } | null {
  if (event.type !== "pane_updated" || !event.pane) return null;

  if (!("label" in event.pane)) return null;

  return { paneId: event.pane.pane_id, label: event.pane.label ?? "" };
}

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";

export function resolveSocketPath(
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return socketPath;

  if (socketPath.startsWith(WINDOWS_PIPE_PREFIX)) return socketPath;

  return `${WINDOWS_PIPE_PREFIX}${socketPath}`;
}

export function subscribe(
  socketPath: string,
  onEvent: (event: HerdrEvent) => void,
): Socket {
  const socket = net.createConnection(resolveSocketPath(socketPath));
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("connect", () => {
    socket.write(
      `${JSON.stringify({
        id: "tab-smart-rename-subscribe",
        method: "events.subscribe",
        params: {
          subscriptions: LIFECYCLE_SUBSCRIPTIONS.map((type) => ({ type })),
        },
      })}\n`,
    );
  });
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;

    while ((index = buffer.indexOf("\n")) !== -1) {
      const rawLine = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

      try {
        const event = normalizeHerdrEvent(JSON.parse(line));

        if (event) onEvent(event);
      } catch {
        // Reconnect handles malformed streams.
      }
    }
  });

  return socket;
}
