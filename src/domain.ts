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
  modelAttempts: Record<string, number>;
  fingerprints: Record<string, string>;
  pendingFingerprints: Record<string, string>;
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
  kind: "workspace" | "tab";
  id: string;
  from: string;
  to: string;
}

export interface RenameResult {
  dryRun: boolean;
  workspace: string;
  tab: string;
  candidate: { workspace: string | null; tab: string | null };
  reason: string;
  usedModel: boolean;
  ownership: { workspaceManual: boolean; tabManual: boolean };
  changes: RenameChange[];
}

export const MAX_TAB_LENGTH = 30;
export const MAX_CONTEXT_CHARS = 4_500;
export const MODEL_RATE_MS = 10 * 60 * 1_000;

export function emptyState(): SmartRenameState {
  return {
    version: 1,
    workspaces: {},
    tabs: {},
    modelAttempts: {},
    fingerprints: {},
    pendingFingerprints: {},
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
  const next = { ...record };
  if (next.expectedLabel === label || next.autoLabel === label) {
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
  const words = value.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  const connectors = new Set(["a", "an", "and", "for", "in", "of", "on", "to", "with"]);
  return words.every(
    (word, index) =>
      /^[A-Z0-9][A-Za-z0-9+.#/'-]*$/.test(word) ||
      (index > 0 && connectors.has(word)),
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
  const process = `${context.focusedPane?.process?.name ?? ""} ${context.focusedPane?.process?.command ?? ""}`.toLowerCase();
  const output = String(context.focusedPane?.recentOutput ?? "").toLowerCase();
  if (/\b(vitest|jest|pytest|rspec|cargo test|go test|node --test|bun test)\b/.test(process)) return "Run Tests";
  if (/\b(next|vite|webpack|astro|rails server|npm run dev|pnpm dev|yarn dev)\b/.test(process)) return "Dev Server";
  if (/\b(tail|journalctl|docker logs)\b/.test(process) || /following logs/.test(output)) return "View Logs";
  if (/\b(ssh|mosh)\b/.test(process)) return "Remote Shell";
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
            origin: timeline.origin.map((text) => boundedText(text, 700)).filter(Boolean),
            middle: timeline.middle.map((text) => boundedText(text, 700)).filter(Boolean),
            recent: timeline.recent.map((text) => boundedText(text, 700)).filter(Boolean),
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
              origin: timeline.origin.slice(0, 1).map((text) => boundedText(text, 300)),
              middle: timeline.middle.slice(0, 1).map((text) => boundedText(text, 300)),
              recent: timeline.recent.slice(-3).map((text) => boundedText(text, 350)),
            },
          }
        : {
            project: boundedText(workspaceName, 80),
            userRequests: requests.slice(-3).map((text) => boundedText(text, 350)),
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
