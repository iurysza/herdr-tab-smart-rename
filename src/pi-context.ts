import { open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { type SessionTimeline } from "./domain.ts";
import { boundedText } from "./text.ts";

const SESSION_HEAD_BYTES = 64 * 1024;

const SESSION_MIDDLE_BYTES = 256 * 1024;

const SESSION_TAIL_BYTES = 512 * 1024;

const CLAUDE_WRAPPER =
  /^(?:<(?:command-name|command-message|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification)\b)/i;

const UserRecordSchema = z.object({
  type: z.enum(["user", "message"]),
  isMeta: z.unknown().optional(),
  isSidechain: z.unknown().optional(),
});

const DirectContentSchema = z.object({ content: z.string() });

const MessageContentSchema = z.object({
  message: z.object({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(z.unknown())]),
  }),
});

const TextPartSchema = z.object({ type: z.literal("text"), text: z.string() });

export interface SessionPane {
  agent?: string | undefined;
  agent_session?: { kind: string; value: string } | undefined;
}

interface OpenSession {
  handle: FileHandle;
  size: number;
}

function contentText(content: z.infer<typeof MessageContentSchema>["message"]["content"]): string {
  if (!Array.isArray(content)) return content;

  return content
    .flatMap((part) => {
      const parsed = TextPartSchema.safeParse(part);

      return parsed.success ? [parsed.data.text] : [];
    })
    .join(" ");
}

function isClaudeNoise(text: string): boolean {
  const trimmed = text.trim();

  if (!trimmed) return true;

  if (CLAUDE_WRAPPER.test(trimmed)) return true;

  if (trimmed.includes("[Request interrupted by user]")) return true;

  if (trimmed.includes("[No response requested]")) return true;

  return false;
}

function userRequestText(line: string): string {
  const value: unknown = JSON.parse(line);
  const record = UserRecordSchema.safeParse(value);

  if (!record.success || record.data.isMeta === true || record.data.isSidechain === true) return "";

  const direct = DirectContentSchema.safeParse(value);
  const message = direct.success ? null : MessageContentSchema.safeParse(value);

  const raw = (direct.success ? direct.data.content : message?.success ? contentText(message.data.message.content) : "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ")
    .trim();

  return isClaudeNoise(raw) ? "" : raw;
}

function sessionsRoot(env: NodeJS.ProcessEnv): string {
  const agentDir =
    env.PI_CODING_AGENT_DIR ||
    path.join(env.HOME || os.homedir(), ".pi", "agent");

  return path.join(agentDir, "sessions");
}

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude");
}

export function claudeRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const root = claudeConfigDir(env);

  return [path.join(root, "transcripts"), path.join(root, "projects")];
}

export function sessionAllowedRoots(
  pane: SessionPane,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return pane.agent === "claude" ? claudeRoots(env) : [sessionsRoot(env)];
}

function isSessionFileName(id: string): boolean {
  if (!id || id.length > 200) return false;

  if (id.includes("..") || id.includes("/") || id.includes("\\")) return false;

  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

async function allowedFile(
  sessionPath: string,
  allowedRoots: string[],
): Promise<string | null> {
  if (!path.isAbsolute(sessionPath)) return null;
  let resolvedPath: string;

  try {
    resolvedPath = await realpath(sessionPath);
  } catch {
    return null;
  }

  const info = await stat(resolvedPath).catch(() => null);

  if (!info?.isFile()) return null;

  for (const root of allowedRoots) {
    let allowedRoot: string;

    try {
      allowedRoot = await realpath(root);
    } catch {
      continue;
    }

    if (
      resolvedPath === allowedRoot ||
      resolvedPath.startsWith(`${allowedRoot}${path.sep}`)
    ) {
      return resolvedPath;
    }
  }

  return null;
}

async function openSession(
  sessionPath: string | null,
  allowedRoots: string[],
): Promise<OpenSession | null> {
  if (!sessionPath) return null;
  const resolvedPath = await allowedFile(sessionPath, allowedRoots);

  if (!resolvedPath) return null;
  const info = await stat(resolvedPath).catch(() => null);

  if (!info?.isFile()) return null;
  const handle = await open(resolvedPath, "r").catch(() => null);

  return handle ? { handle, size: info.size } : null;
}

export async function resolveClaudeSessionId(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (!isSessionFileName(id)) return null;
  const roots = claudeRoots(env);
  const fileName = `${id}.jsonl`;

  const transcripts = await allowedFile(
    path.join(claudeConfigDir(env), "transcripts", fileName),
    roots,
  );

  if (transcripts) return transcripts;

  const projectsRoot = path.join(claudeConfigDir(env), "projects");
  let entries: string[] = [];

  try {
    entries = await readdir(projectsRoot);
  } catch {
    return null;
  }

  const matches: string[] = [];

  for (const entry of entries) {
    const candidate = await allowedFile(
      path.join(projectsRoot, entry, fileName),
      roots,
    );

    if (candidate) matches.push(candidate);
  }

  return matches.length === 1 ? matches[0]! : null;
}

export async function paneSessionPath(
  pane: SessionPane,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const session = pane.agent_session;

  if (!session?.value) return null;

  if (pane.agent === "pi" && session.kind === "path") return session.value;

  if (pane.agent !== "claude") return null;

  if (session.kind === "path") return session.value;

  if (session.kind === "id") return resolveClaudeSessionId(session.value, env);

  return null;
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
      const value = boundedText(userRequestText(line), 2_000);

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
  allowedRoots = [sessionsRoot(env)],
): Promise<string[]> {
  const session = await openSession(sessionPath, allowedRoots);

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
  allowedRoots = [sessionsRoot(env)],
): Promise<SessionTimeline> {
  const session = await openSession(sessionPath, allowedRoots);

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

export async function paneSessionMessages(
  pane: SessionPane,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SessionTimeline> {
  const sessionPath = await paneSessionPath(pane, env);

  return sampledUserMessages(sessionPath, env, sessionAllowedRoots(pane, env));
}
