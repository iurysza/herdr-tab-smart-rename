import net, { type Socket } from "node:net";
import { z } from "zod";
import { type PaneContext } from "./domain.ts";
import { sampledUserMessages } from "./pi-context.ts";
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
    pane: z.object({ tab_id: z.string().optional() }).optional(),
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

const TAB_PROGRESS_MARKER = "\u2063";
const TAB_PROGRESS_FRAMES = ["◇", "◈", "◆", "◈"] as const;
const TAB_PROGRESS_INTERVAL_MS = 120;

export function tabProgressBase(label: string): string | null {
  if (!label.startsWith(TAB_PROGRESS_MARKER)) return null;
  const separator = label.indexOf(" ", TAB_PROGRESS_MARKER.length);
  if (separator < 0) return null;
  const frame = label.slice(TAB_PROGRESS_MARKER.length, separator);
  if (!(TAB_PROGRESS_FRAMES as readonly string[]).includes(frame)) return null;
  return label.slice(separator + 1);
}

function tabProgressLabel(base: string, frame: string): string {
  return `${TAB_PROGRESS_MARKER}${frame} ${base}`;
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
  kind: "workspace" | "tab",
  id: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await run(env.HERDR_BIN_PATH || "herdr", [kind, "rename", id, label], { env });
}

export async function beginTabProgress(
  tab: HerdrTab,
  env: NodeJS.ProcessEnv = process.env,
): Promise<() => Promise<void>> {
  const base = tab.label;
  let expected = base;
  let frame = 0;
  let stopped = false;
  let work = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const update = (nextFrame: number): Promise<void> => {
    work = work
      .then(async () => {
        if (stopped) return;
        const current = (await snapshot(env)).tabs.find(
          (item) => item.tab_id === tab.tab_id,
        )?.label;
        if (stopped || current !== expected) {
          stopped = true;
          return;
        }
        const next = tabProgressLabel(base, TAB_PROGRESS_FRAMES[nextFrame]!);
        await rename("tab", tab.tab_id, next, env);
        expected = next;
        frame = nextFrame;
      })
      .catch(() => {
        stopped = true;
      });
    return work;
  };

  const schedule = (): void => {
    timer = setTimeout(() => {
      void update((frame + 1) % TAB_PROGRESS_FRAMES.length).then(() => {
        if (!stopped) schedule();
      });
    }, TAB_PROGRESS_INTERVAL_MS);
  };

  await update(0);
  if (!stopped) schedule();

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await work;
    if (expected === base) return;
    try {
      const current = (await snapshot(env)).tabs.find(
        (item) => item.tab_id === tab.tab_id,
      )?.label;
      if (current === expected) await rename("tab", tab.tab_id, base, env);
    } catch {
      // Progress cleanup must not hide the naming result.
    }
  };
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
  const sessionPath =
    pane.agent === "pi" && pane.agent_session?.kind === "path"
      ? pane.agent_session.value
      : null;
  const [process, recentOutput, sessionMessages] = await Promise.all([
    paneProcess(pane.pane_id, env),
    paneRecent(pane.pane_id, env),
    sampledUserMessages(sessionPath, env),
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

export function subscribe(
  socketPath: string,
  onEvent: (event: HerdrEvent) => void,
): Socket {
  const socket = net.createConnection(socketPath);
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
