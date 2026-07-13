import { createHash } from "node:crypto";
import path from "node:path";

export const MAX_TAB_LENGTH = 30;
export const MAX_CONTEXT_CHARS = 4_500;
export const MODEL_RATE_MS = 10 * 60 * 1_000;

export function emptyState() {
  return {
    version: 1,
    workspaces: {},
    tabs: {},
    modelAttempts: {},
    fingerprints: {},
    pendingFingerprints: {},
  };
}

export function isDefaultLabel(label, number) {
  const value = String(label ?? "").trim();
  return !value || /^\d+$/.test(value) || value === String(number ?? "");
}

export function reconcileItem(record, currentLabel, eligible = false) {
  const next = { ...(record ?? {}) };
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

export function acknowledgeRename(record, label) {
  const next = { ...(record ?? {}) };
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

export function prepareRename(record, label) {
  return { ...(record ?? {}), expectedLabel: label, manual: false };
}

export function resetOwnership(record) {
  return { ...(record ?? {}), manual: false, autoLabel: undefined, expectedLabel: undefined };
}

export function sanitize(text, home = process.env.HOME ?? "") {
  let value = String(text ?? "")
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/\/var\/folders\/\S*?pi-clipboard-[\w-]+\.(png|jpe?g|gif|webp)/gi, "[clipboard image]")
    .replace(/\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[^\s"']+/gi, "Authorization: [redacted]")
    .replace(/\b(?:Bearer)\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s]+)/g, (match) => `${match.split(/\s*[:=]\s*/, 1)[0]}=[redacted]`)
    .replace(/\b(api[-_]?key|token|secret|password)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi, "$1$2[redacted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{12,})\b/g, "[redacted-token]");
  if (home) value = value.replaceAll(home, "~");
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function boundedText(text, max, home) {
  return sanitize(text, home).slice(0, max);
}

export function titleCase(words) {
  const acronyms = new Set(["api", "cli", "ui", "pr", "var", "rpc", "mvp"]);
  return String(words ?? "")
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      acronyms.has(word.toLowerCase())
        ? word.toUpperCase()
        : word[0].toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(" ");
}

export function validateTabLabel(label) {
  if (/[\r\n]/.test(String(label ?? ""))) return false;
  const value = sanitize(label);
  if (!value || value.length > MAX_TAB_LENGTH) return false;
  const words = value.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  const lowercaseConnectors = new Set(["a", "an", "and", "for", "in", "of", "on", "to", "with"]);
  return words.every(
    (word, index) =>
      /^[A-Z0-9][A-Za-z0-9+.#/'-]*$/.test(word) ||
      (index > 0 && lowercaseConnectors.has(word)),
  );
}

export function workspaceCandidate(workspace, stablePane, gitRoot) {
  const current = String(workspace?.label ?? "").trim();
  const stableCurrent = current && !isDefaultLabel(current, workspace?.number) ? current : null;
  const identity =
    workspace?.worktree?.repo_name ||
    stableCurrent ||
    (gitRoot && path.basename(gitRoot)) ||
    path.basename(stablePane?.foreground_cwd || stablePane?.cwd || "") ||
    current;
  return titleCase(identity);
}

export function heuristicTitle(context) {
  const process = `${context?.focusedPane?.process?.name ?? ""} ${context?.focusedPane?.process?.command ?? ""}`.toLowerCase();
  const output = String(context?.focusedPane?.recentOutput ?? "").toLowerCase();
  if (/\b(vitest|jest|pytest|rspec|cargo test|go test|node --test)\b/.test(process)) return "Run Tests";
  if (/\b(next|vite|webpack|astro|rails server|npm run dev|pnpm dev|yarn dev)\b/.test(process)) return "Dev Server";
  if (/\b(tail|journalctl|docker logs)\b/.test(process) || /following logs/.test(output)) return "View Logs";
  if (/\b(ssh|mosh)\b/.test(process)) return "Remote Shell";
  return null;
}

function boundedProcess(process, commandLimit = 400) {
  if (!process) return null;
  return {
    name: boundedText(process.name, 80),
    command: boundedText(process.command, commandLimit),
    cwd: boundedText(process.cwd, 160),
  };
}

export function buildModelContext({ workspaceName, paneContexts }) {
  const focused = paneContexts.find((pane) => pane.focused) ?? paneContexts[0] ?? {};
  const requests = (focused.userMessages ?? [])
    .map((text) => boundedText(text, 700))
    .filter(Boolean)
    .slice(-6);
  const sessionMessages = focused.sessionMessages;
  const hasSessionTimeline = ["origin", "middle", "recent"].some(
    (section) => sessionMessages?.[section]?.length,
  );
  const taskEvidence = hasSessionTimeline
    ? {
        sessionTimeline: {
          origin: (sessionMessages.origin ?? [])
            .map((text) => boundedText(text, 700))
            .filter(Boolean),
          middle: (sessionMessages.middle ?? [])
            .map((text) => boundedText(text, 700))
            .filter(Boolean),
          recent: (sessionMessages.recent ?? [])
            .map((text) => boundedText(text, 700))
            .filter(Boolean),
        },
      }
    : { userRequests: requests };

  let context = requests.length
    ? {
        project: boundedText(workspaceName, 80),
        ...taskEvidence,
      }
    : {
        project: boundedText(workspaceName, 80),
        focusedPane: {
          process: boundedProcess(focused.process),
          recentOutput: boundedText(focused.recentOutput, 500),
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
      ? {
          project: boundedText(workspaceName, 80),
          ...(hasSessionTimeline
            ? {
                sessionTimeline: {
                  origin: (sessionMessages.origin ?? [])
                    .slice(0, 1)
                    .map((text) => boundedText(text, 300)),
                  middle: (sessionMessages.middle ?? [])
                    .slice(0, 1)
                    .map((text) => boundedText(text, 300)),
                  recent: (sessionMessages.recent ?? [])
                    .slice(-3)
                    .map((text) => boundedText(text, 350)),
                },
              }
            : {
                userRequests: requests
                  .slice(-3)
                  .map((text) => boundedText(text, 350)),
              }),
        }
      : {
          project: boundedText(workspaceName, 80),
          focusedPane: {
            process: boundedProcess(focused.process, 250),
            recentOutput: boundedText(focused.recentOutput, 350),
          },
        };
  }

  if (JSON.stringify(context).length > MAX_CONTEXT_CHARS) {
    throw new Error("model context exceeded hard limit");
  }
  return context;
}

export function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function observeStableContext(state, tabId, context) {
  state.pendingFingerprints ??= {};
  const mark = fingerprint(context);
  if (state.pendingFingerprints[tabId] === mark) return true;
  state.pendingFingerprints[tabId] = mark;
  return false;
}

export function shouldCallModel(state, tabId, context, now = Date.now()) {
  const mark = fingerprint(context);
  return {
    allowed:
      state.fingerprints[tabId] !== mark &&
      now - (state.modelAttempts[tabId] ?? 0) >= MODEL_RATE_MS,
    fingerprint: mark,
  };
}

export function markModelAttempt(state, tabId, now = Date.now()) {
  state.modelAttempts[tabId] = now;
}

export function markModelSuccess(state, tabId, context) {
  state.fingerprints[tabId] = fingerprint(context);
  delete state.pendingFingerprints?.[tabId];
}

export function parseModelTitle(text) {
  const cleaned = String(text)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const parsed = JSON.parse(cleaned);
  if (parsed.tab === null) {
    return { tab: null, reason: sanitize(parsed.reason) };
  }
  if (!validateTabLabel(parsed.tab)) {
    throw new Error(`invalid model tab label: ${JSON.stringify(parsed.tab)}`);
  }
  return { tab: sanitize(parsed.tab), reason: sanitize(parsed.reason) };
}
