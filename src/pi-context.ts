import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { type SessionTimeline } from "./domain.ts";
import { boundedText } from "./text.ts";

const SESSION_HEAD_BYTES = 64 * 1024;
const SESSION_MIDDLE_BYTES = 256 * 1024;
const SESSION_TAIL_BYTES = 512 * 1024;

const UserMessageSchema = z.object({
  type: z.literal("message"),
  message: z.object({
    role: z.literal("user"),
    content: z.union([
      z.string(),
      z.array(
        z.looseObject({
          type: z.string(),
          text: z.string().optional(),
        }),
      ),
    ]),
  }),
});

interface OpenSession {
  handle: FileHandle;
  size: number;
}

function contentText(content: z.infer<typeof UserMessageSchema>["message"]["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join(" ");
}

function sessionsRoot(env: NodeJS.ProcessEnv): string {
  const agentDir =
    env.PI_CODING_AGENT_DIR ||
    path.join(env.HOME || os.homedir(), ".pi", "agent");
  return path.join(agentDir, "sessions");
}

async function openSession(
  sessionPath: string | null,
  env: NodeJS.ProcessEnv,
): Promise<OpenSession | null> {
  if (!sessionPath || !path.isAbsolute(sessionPath)) return null;

  let allowedRoot: string;
  let resolvedPath: string;
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

async function readSessionWindow(
  handle: FileHandle,
  size: number,
  start: number,
  length: number,
): Promise<string> {
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

function userMessagesFrom(text: string): string[] {
  const messages: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line) continue;
    try {
      const entry = UserMessageSchema.safeParse(JSON.parse(line));
      if (!entry.success) continue;
      const value = boundedText(contentText(entry.data.message.content), 2_000);
      if (value) messages.push(value);
    } catch {
      // Ignore partial and non-JSON records.
    }
  }
  return messages;
}

export async function recentUserMessages(
  sessionPath: string,
  limit = 6,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
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

export async function sampledUserMessages(
  sessionPath: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SessionTimeline> {
  const session = await openSession(sessionPath, env);
  if (!session) return { origin: [], middle: [], recent: [] };
  try {
    const middleStart = Math.max(
      0,
      Math.floor((session.size - SESSION_MIDDLE_BYTES) / 2),
    );
    const tailStart = Math.max(0, session.size - SESSION_TAIL_BYTES);
    const [headText, middleText, tailText] = await Promise.all([
      readSessionWindow(session.handle, session.size, 0, SESSION_HEAD_BYTES),
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
