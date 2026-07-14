import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import { boundedText } from "./core.mjs";
import { sampledUserMessages } from "./pi-sessions.mjs";

const execFileAsync = promisify(execFile);

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
];

export async function run(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    timeout: options.timeout ?? 10_000,
    maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
    env: options.env ?? process.env,
  });
  return stdout.trim();
}

export async function herdrJson(args, env = process.env) {
  return JSON.parse(await run(env.HERDR_BIN_PATH || "herdr", args, { env }));
}

export async function snapshot(env = process.env) {
  return (await herdrJson(["api", "snapshot"], env)).result.snapshot;
}

export async function rename(kind, id, label, env = process.env) {
  await run(env.HERDR_BIN_PATH || "herdr", [kind, "rename", id, label], { env });
}

export async function gitRoot(cwd) {
  if (!cwd) return null;
  try {
    return await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
}

export async function paneRecent(paneId, env = process.env) {
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

export async function paneProcess(paneId, env = process.env) {
  try {
    const data = await herdrJson(["pane", "process-info", "--pane", paneId], env);
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

export async function focusedPaneContext(pane, env = process.env) {
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

export async function siblingPaneContext(pane, env = process.env) {
  return {
    focused: false,
    label: boundedText(pane.label, 80),
    process: await paneProcess(pane.pane_id, env),
    recentOutput: "",
    userMessages: [],
  };
}

export function normalizeHerdrEvent(message) {
  if (!message || typeof message.event !== "string" || !message.data) return null;
  return {
    ...message.data,
    eventName: message.event,
    type: message.data.type || message.event.replaceAll(".", "_"),
  };
}

export function subscribe(socketPath, onEvent) {
  const socket = net.createConnection(socketPath);
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("connect", () => {
    socket.write(
      `${JSON.stringify({
        id: "autoname-subscribe",
        method: "events.subscribe",
        params: {
          subscriptions: LIFECYCLE_SUBSCRIPTIONS.map((type) => ({ type })),
        },
      })}\n`,
    );
  });
  socket.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
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
