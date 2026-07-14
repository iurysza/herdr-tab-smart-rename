import { execFile } from "node:child_process";
import { open, realpath, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { boundedText } from "./core.mjs";

const execFileAsync = promisify(execFile);
const SESSION_HEAD_BYTES = 64 * 1024;
const SESSION_MIDDLE_BYTES = 256 * 1024;
const SESSION_TAIL_BYTES = 512 * 1024;

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

function contentText(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join(" ")
    : "";
}

function sessionsRoot(env) {
  const agentDir = env.PI_CODING_AGENT_DIR || path.join(env.HOME || os.homedir(), ".pi", "agent");
  return path.join(agentDir, "sessions");
}

async function openSession(sessionPath, env) {
  if (!sessionPath || !path.isAbsolute(sessionPath)) return null;

  let allowedRoot;
  let resolvedPath;
  try {
    [allowedRoot, resolvedPath] = await Promise.all([
      realpath(sessionsRoot(env)),
      realpath(sessionPath),
    ]);
  } catch {
    return null;
  }
  if (!resolvedPath.startsWith(`${allowedRoot}${path.sep}`)) return null;

  const info = await stat(resolvedPath).catch(() => null);
  if (!info?.isFile()) return null;
  const handle = await open(resolvedPath, "r").catch(() => null);
  return handle ? { handle, size: info.size } : null;
}

async function readSessionWindow(handle, size, start, length) {
  const offset = Math.max(0, Math.min(start, size));
  const count = Math.max(0, Math.min(length, size - offset));
  const buffer = Buffer.alloc(count);
  const { bytesRead } = await handle.read(buffer, 0, count, offset);
  let text = buffer.subarray(0, bytesRead).toString("utf8");
  if (offset > 0) {
    const newline = text.indexOf("\n");
    text = newline === -1 ? "" : text.slice(newline + 1);
  }
  if (offset + bytesRead < size) {
    const newline = text.lastIndexOf("\n");
    text = newline === -1 ? "" : text.slice(0, newline + 1);
  }
  return text;
}

function userMessagesFrom(text) {
  const messages = [];
  for (let line of text.split("\n")) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type !== "message" || entry.message?.role !== "user") continue;
      const value = boundedText(contentText(entry.message.content), 2_000);
      if (value) messages.push(value);
    } catch {
      // Ignore partial and non-JSON records.
    }
  }
  return messages;
}

export async function recentUserMessages(sessionPath, limit = 6, env = process.env) {
  const session = await openSession(sessionPath, env);
  if (!session) return [];
  try {
    const start = Math.max(0, session.size - SESSION_TAIL_BYTES);
    const text = await readSessionWindow(
      session.handle,
      session.size,
      start,
      SESSION_TAIL_BYTES,
    );
    return userMessagesFrom(text).slice(-limit);
  } finally {
    await session.handle.close();
  }
}

export async function sampledUserMessages(sessionPath, env = process.env) {
  const session = await openSession(sessionPath, env);
  if (!session) return { origin: [], middle: [], recent: [] };
  try {
    const middleStart = Math.max(
      0,
      Math.floor((session.size - SESSION_MIDDLE_BYTES) / 2),
    );
    const tailStart = Math.max(0, session.size - SESSION_TAIL_BYTES);
    const [headText, middleText, tailText] = await Promise.all([
      readSessionWindow(
        session.handle,
        session.size,
        0,
        SESSION_HEAD_BYTES,
      ),
      readSessionWindow(
        session.handle,
        session.size,
        middleStart,
        SESSION_MIDDLE_BYTES,
      ),
      readSessionWindow(
        session.handle,
        session.size,
        tailStart,
        SESSION_TAIL_BYTES,
      ),
    ]);
    const head = userMessagesFrom(headText);
    const middle = userMessagesFrom(middleText);
    const recent = userMessagesFrom(tailText);
    const originMessage = head[0];
    const middleMessage = middle[Math.floor(middle.length / 2)];
    const seen = new Set([originMessage, middleMessage].filter(Boolean));
    return {
      origin: originMessage ? [originMessage] : [],
      middle:
        middleMessage && middleMessage !== originMessage ? [middleMessage] : [],
      recent: recent.filter((message) => !seen.has(message)).slice(-4),
    };
  } finally {
    await session.handle.close();
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
