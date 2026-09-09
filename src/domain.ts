import { createHash } from "node:crypto";
import path from "node:path";
import { boundedText, sanitizeText } from "./text.ts";

export interface OwnershipRecord {
  manual?: boolean | undefined;
  autoLabel?: string | undefined;
  expectedLabel?: string | undefined;
  observedLabel?: string | undefined;
}

export interface SmartRenameState {
  version: 1;
  workspaces: Record<string, OwnershipRecord>;
  tabs: Record<string, OwnershipRecord>;
  panes: Record<string, OwnershipRecord>;
  modelAttempts: Record<string, number>;
  fingerprints: Record<string, string>;
  pendingFingerprints: Record<string, string>;
  // Latest decision per target, retained after completion to reject older reads.
  evaluations: Record<string, string>;
  [key: string]: unknown;
}

export interface ProcessInfo {
  name: string;
  command: string;
  cwd: string;
}

export interface SessionTimeline {
  origin: string[];
  middle: string[];
  recent: string[];
}

export interface PaneContext {
  focused: boolean;
  label: string;
  process: ProcessInfo | null;
  recentOutput: string;
  userMessages: string[];
  sessionMessages?: SessionTimeline;
}

interface ProcessEvidence {
  process: ProcessInfo | null;
  recentOutput: string;
}

interface SiblingEvidence {
  label: string;
  process: ProcessInfo | null;
}

export type NamingContext =
  | { project: string; sessionTimeline: SessionTimeline }
  | { project: string; userRequests: string[] }
  | {
      project: string;
      focusedPane: ProcessEvidence;
      siblingPanes?: SiblingEvidence[];
    };

export interface NameSuggestion {
  tab: string | null;
  reason: string;
}

export interface RenameChange {
  kind: "workspace" | "tab" | "pane";
  id: string;
  from: string;
  to: string;
}

export interface RenameOutcome {
  kind: RenameChange["kind"];
  id: string;
  status: "renamed" | "unchanged" | "skipped" | "failed";
  reason: string;
}

export interface RenameResult {
  dryRun: boolean;
  workspace: string;
  tab: string;
  candidate: {
    workspace: string | null;
    tab: string | null;
    panes?: Record<string, string | null>;
  };
  reason: string;
  usedModel: boolean;
  ownership: { workspaceManual: boolean; tabManual: boolean };
  changes: RenameChange[];
  outcomes?: RenameOutcome[];
}

export const MAX_TAB_LENGTH = 30;
export const MAX_CONTEXT_CHARS = 4_500;
export const MODEL_RATE_MS = 10 * 60 * 1_000;

export function emptyState(): SmartRenameState {
  return {
    version: 1,
    workspaces: {},
    tabs: {},
    panes: {},
    modelAttempts: {},
    fingerprints: {},
    pendingFingerprints: {},
    evaluations: {},
  };
}

export function isDefaultLabel(label: unknown, number?: unknown): boolean {
  const value = String(label ?? "").trim();
  return !value || /^\d+$/.test(value) || value === String(number ?? "");
}

export function reconcileItem(
  record: OwnershipRecord | undefined,
  currentLabel: string,
  eligible = false,
): OwnershipRecord {
  const next = { ...record };
  const previousObserved = next.observedLabel;
  if (next.expectedLabel) {
    if (currentLabel === next.expectedLabel) {
      next.autoLabel = currentLabel;
      delete next.expectedLabel;
      next.manual = false;
    } else {
      delete next.expectedLabel;
      next.manual = true;
    }
  } else if (next.autoLabel && currentLabel !== next.autoLabel) {
    next.manual = true;
  } else if (
    record &&
    previousObserved !== undefined &&
    currentLabel !== previousObserved
  ) {
    next.manual = true;
  } else if (!record) {
    next.manual = !eligible;
  }
  next.observedLabel = currentLabel;
  return next;
}

export function acknowledgeRename(
  record: OwnershipRecord | undefined,
  label: string,
): OwnershipRecord {
  if (!record) return reconcileItem(undefined, label, isDefaultLabel(label));
  // pane.updated contains the label even when only status or metadata changed.
  // An older unchanged event must not consume a pending automatic write.
  if (record.observedLabel === label && record.expectedLabel !== label) {
    return { ...record };
  }
  const next = { ...record };
  if (
    next.expectedLabel === label ||
    (!next.manual && next.autoLabel === label)
  ) {
    next.autoLabel = label;
    delete next.expectedLabel;
    next.manual = false;
  } else {
    delete next.expectedLabel;
    next.manual = true;
  }
  next.observedLabel = label;
  return next;
}

export function prepareRename(
  record: OwnershipRecord | undefined,
  label: string,
): OwnershipRecord {
  return { ...record, expectedLabel: label, manual: false };
}

export function resetOwnership(
  record: OwnershipRecord | undefined,
): OwnershipRecord {
  const next = { ...record, manual: false };
  delete next.autoLabel;
  delete next.expectedLabel;
  return next;
}

export function titleCase(input: unknown): string {
  const acronyms = new Set(["api", "cli", "ui", "pr", "var", "rpc", "mvp"]);
  return String(input ?? "")
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      acronyms.has(word.toLowerCase())
        ? word.toUpperCase()
        : word[0]!.toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(" ");
}

export function validateTabLabel(label: unknown): label is string {
  if (/[\r\n]/.test(String(label ?? ""))) return false;
  const value = sanitizeText(label);
  if (!value || value.length > MAX_TAB_LENGTH) return false;

  if (/\p{Script=Han}/u.test(value)) {
    if (value.length < 2) return false;
    return /^[\p{Script=Han}A-Za-z0-9][\p{Script=Han}A-Za-z0-9\s+.#/'-_&·]*[\p{Script=Han}A-Za-z0-9+]$/u.test(
      value,
    );
  }

  const words = value.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  const connectors: Record<string, true> = {
    a: true,
    an: true,
    and: true,
    for: true,
    in: true,
    of: true,
    on: true,
    to: true,
    with: true,
  };
  return words.every(
    (word, index) =>
      /^[A-Z0-9][A-Za-z0-9+.#/'-]*$/.test(word) ||
      (index > 0 && connectors[word]),
  );
}

interface WorkspaceIdentity {
  label?: unknown;
  number?: unknown;
  worktree?: { repo_name?: unknown } | null | undefined;
}

interface StablePane {
  foreground_cwd?: string | undefined;
  cwd?: string | undefined;
}

export function workspaceCandidate(
  workspace: WorkspaceIdentity,
  stablePane?: StablePane,
  gitRoot?: string | null,
): string {
  const current = String(workspace.label ?? "").trim();
  const stableCurrent =
    current && !isDefaultLabel(current, workspace.number) ? current : null;
  const identity =
    workspace.worktree?.repo_name ||
    stableCurrent ||
    (gitRoot && path.basename(gitRoot)) ||
    path.basename(stablePane?.foreground_cwd || stablePane?.cwd || "") ||
    current;
  return titleCase(identity);
}

export function heuristicTitle(context: {
  focusedPane?: {
    process?: Partial<ProcessInfo> | null;
    recentOutput?: string;
  };
}): string | null {
  const process = context.focusedPane?.process;
  const command = (process?.command || process?.name || "").trim();
  const words = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const executable = path.posix
    .basename(
      (words[0] ?? "").replace(/^['"]|['"]$/g, "").replaceAll("\\", "/"),
    )
    .replace(/\.exe$/i, "")
    .toLowerCase();
  const args = words.slice(1);
  if (
    ["vitest", "jest", "pytest", "rspec"].includes(executable) ||
    (["cargo", "go", "bun"].includes(executable) && args[0] === "test") ||
    (executable === "node" && args[0] === "--test")
  )
    return "Run Tests";
  if (
    (["next", "astro"].includes(executable) &&
      ["dev", "start"].includes(args[0] ?? "")) ||
    (executable === "vite" &&
      (!args[0] || args[0].startsWith("-") || args[0] === "dev")) ||
    (executable === "webpack" && args[0] === "serve") ||
    (executable === "rails" && args[0] === "server") ||
    (["npm", "pnpm", "yarn"].includes(executable) &&
      (args[0] === "dev" || (args[0] === "run" && args[1] === "dev")))
  )
    return "Dev Server";
  if (
    ["tail", "journalctl"].includes(executable) ||
    (executable === "docker" && args[0] === "logs")
  )
    return "View Logs";
  if (["ssh", "mosh"].includes(executable)) return "Remote Shell";
  return null;
}

function boundedProcess(
  process: ProcessInfo | null | undefined,
  commandLimit = 400,
): ProcessInfo | null {
  if (!process) return null;
  return {
    name: boundedText(process.name, 80),
    command: boundedText(process.command, commandLimit),
    cwd: boundedText(process.cwd, 160),
  };
}

export function buildModelContext({
  workspaceName,
  paneContexts,
}: {
  workspaceName: string;
  paneContexts: PaneContext[];
}): NamingContext {
  const focused = paneContexts.find((pane) => pane.focused) ?? paneContexts[0];
  const requests = (focused?.userMessages ?? [])
    .map((text) => boundedText(text, 700))
    .filter(Boolean)
    .slice(-6);
  const timeline = focused?.sessionMessages;
  const hasTimeline = ["origin", "middle", "recent"].some(
    (section) => timeline?.[section as keyof SessionTimeline]?.length,
  );

  let context: NamingContext = requests.length
    ? hasTimeline && timeline
      ? {
          project: boundedText(workspaceName, 80),
          sessionTimeline: {
            origin: timeline.origin
              .map((text) => boundedText(text, 700))
              .filter(Boolean),
            middle: timeline.middle
              .map((text) => boundedText(text, 700))
              .filter(Boolean),
            recent: timeline.recent
              .map((text) => boundedText(text, 700))
              .filter(Boolean),
          },
        }
      : { project: boundedText(workspaceName, 80), userRequests: requests }
    : {
        project: boundedText(workspaceName, 80),
        focusedPane: {
          process: boundedProcess(focused?.process),
          recentOutput: boundedText(focused?.recentOutput, 500),
        },
        siblingPanes: paneContexts
          .filter((pane) => !pane.focused)
          .slice(0, 4)
          .map((pane) => ({
            label: boundedText(pane.label, 80),
            process: boundedProcess(pane.process, 240),
          })),
      };

  if (JSON.stringify(context).length > MAX_CONTEXT_CHARS) {
    context = requests.length
      ? hasTimeline && timeline
        ? {
            project: boundedText(workspaceName, 80),
            sessionTimeline: {
              origin: timeline.origin
                .slice(0, 1)
                .map((text) => boundedText(text, 300)),
              middle: timeline.middle
                .slice(0, 1)
                .map((text) => boundedText(text, 300)),
              recent: timeline.recent
                .slice(-3)
                .map((text) => boundedText(text, 350)),
            },
          }
        : {
            project: boundedText(workspaceName, 80),
            userRequests: requests
              .slice(-3)
              .map((text) => boundedText(text, 350)),
          }
      : {
          project: boundedText(workspaceName, 80),
          focusedPane: {
            process: boundedProcess(focused?.process, 250),
            recentOutput: boundedText(focused?.recentOutput, 350),
          },
        };
  }

  if (JSON.stringify(context).length > MAX_CONTEXT_CHARS) {
    throw new Error("model context exceeded hard limit");
  }
  return context;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function observeStableContext(
  state: SmartRenameState,
  tabId: string,
  context: NamingContext,
): boolean {
  const mark = fingerprint(context);
  if (state.pendingFingerprints[tabId] === mark) return true;
  state.pendingFingerprints[tabId] = mark;
  return false;
}

export function shouldCallModel(
  state: SmartRenameState,
  tabId: string,
  context: NamingContext,
  now = Date.now(),
): { allowed: boolean; fingerprint: string } {
  const mark = fingerprint(context);
  return {
    allowed:
      state.fingerprints[tabId] !== mark &&
      now - (state.modelAttempts[tabId] ?? 0) >= MODEL_RATE_MS,
    fingerprint: mark,
  };
}

export function markModelAttempt(
  state: SmartRenameState,
  tabId: string,
  now = Date.now(),
): void {
  state.modelAttempts[tabId] = now;
}

export function markModelSuccess(
  state: SmartRenameState,
  tabId: string,
  context: NamingContext,
): void {
  state.fingerprints[tabId] = fingerprint(context);
  delete state.pendingFingerprints[tabId];
}
