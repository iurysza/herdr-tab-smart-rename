import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename as moveFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  acknowledgeRename,
  buildModelContext,
  emptyState,
  heuristicTitle,
  isDefaultLabel,
  markModelAttempt,
  markModelSuccess,
  observeStableContext,
  prepareRename,
  reconcileItem,
  resetOwnership,
  shouldCallModel,
  workspaceCandidate,
} from "./core.mjs";
import {
  focusedPaneContext,
  gitRoot,
  rename,
  siblingPaneContext,
  snapshot,
} from "./integrations.mjs";
import { acquireLock } from "./singleton.mjs";

export function statePaths(stateDir) {
  return {
    state: path.join(stateDir, "state.json"),
    pid: path.join(stateDir, "worker.json"),
    startLock: path.join(stateDir, "start.lock"),
    stateLock: path.join(stateDir, "state.lock"),
    log: path.join(stateDir, "worker.log"),
  };
}

export async function ensurePrivateDir(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

export async function loadState(file) {
  if (!file) return emptyState();
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return { ...emptyState(), ...parsed };
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    throw error;
  }
}

export async function saveState(file, state) {
  await ensurePrivateDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await moveFile(temporary, file);
  await chmod(file, 0o600);
}

export async function withStateTransaction(stateFile, lockFile, operation) {
  const release = await acquireLock(lockFile);
  try {
    const state = await loadState(stateFile);
    const persist = () => saveState(stateFile, state);
    const result = await operation(state, persist);
    await persist();
    return result;
  } finally {
    await release();
  }
}

export function focusedPaneFor(tab, snap) {
  const panes = snap.panes.filter((pane) => pane.tab_id === tab.tab_id);
  const layout = snap.layouts.find((item) => item.tab_id === tab.tab_id);
  const id = layout?.focused_pane_id ?? snap.focused_pane_id;
  const focused = panes.find((pane) => pane.pane_id === id);
  return (
    (focused?.agent ? focused : null) ??
    panes.find(
      (pane) =>
        pane.agent && ["working", "blocked"].includes(pane.agent_status),
    ) ??
    focused ??
    panes[0]
  );
}

export function reconcileSnapshot(state, snap) {
  for (const workspace of snap.workspaces) {
    state.workspaces[workspace.workspace_id] = reconcileItem(
      state.workspaces[workspace.workspace_id],
      workspace.label,
      isDefaultLabel(workspace.label, workspace.number),
    );
  }
  for (const tab of snap.tabs) {
    state.tabs[tab.tab_id] = reconcileItem(
      state.tabs[tab.tab_id],
      tab.label,
      isDefaultLabel(tab.label, tab.number),
    );
  }
  return state;
}

const defaultDependencies = {
  snapshot,
  gitRoot,
  focusedPaneContext,
  siblingPaneContext,
  rename,
};

export class AutoNameService {
  constructor({
    stateFile,
    stateLock,
    pi,
    env = process.env,
    dryRun = false,
    dependencies = {},
  }) {
    this.stateFile = stateFile;
    this.stateLock = stateLock;
    this.pi = pi;
    this.env = env;
    this.dryRun = dryRun;
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  async initialize(snap = null) {
    const current = snap ?? (await this.dependencies.snapshot(this.env));
    if (this.dryRun || !this.stateFile) return current;
    await withStateTransaction(this.stateFile, this.stateLock, async (state) => {
      reconcileSnapshot(state, current);
    });
    return current;
  }

  async acknowledge(kind, id, label) {
    if (!this.stateFile) return;
    await withStateTransaction(this.stateFile, this.stateLock, async (state) => {
      const collection = kind === "tab" ? state.tabs : state.workspaces;
      collection[id] = acknowledgeRename(collection[id], label);
    });
  }

  async contextFor(tab, snap, workspaceName) {
    const focusedPane = focusedPaneFor(tab, snap);
    const panes = snap.panes.filter((pane) => pane.tab_id === tab.tab_id);
    const paneContexts = [];
    for (const pane of panes) {
      paneContexts.push(
        pane.pane_id === focusedPane?.pane_id
          ? await this.dependencies.focusedPaneContext(pane, this.env)
          : await this.dependencies.siblingPaneContext(pane, this.env),
      );
    }
    return {
      focusedPane,
      paneContexts,
      context: buildModelContext({ workspaceName, paneContexts }),
    };
  }

  async workspaceDetails(workspace, snap) {
    const stablePane = snap.panes.find(
      (pane) => pane.workspace_id === workspace.workspace_id,
    );
    const needsFallback =
      !workspace.worktree?.repo_name &&
      isDefaultLabel(workspace.label, workspace.number);
    const root = needsFallback
      ? await this.dependencies.gitRoot(
          stablePane?.foreground_cwd ?? stablePane?.cwd,
        )
      : null;
    return {
      stablePane,
      workspaceName: workspaceCandidate(workspace, stablePane, root),
    };
  }

  async evaluateAll(initial = null, options = {}) {
    const snap = initial ?? (await this.dependencies.snapshot(this.env));
    const results = [];
    for (const tab of snap.tabs) {
      const result = await this.evaluate(tab.tab_id, options);
      if (result) results.push(result);
    }
    return results;
  }

  async evaluate(tabId, options = {}) {
    if (this.dryRun || !this.stateFile) {
      const snap =
        options.snapshot ?? (await this.dependencies.snapshot(this.env));
      const state = await loadState(this.stateFile);
      reconcileSnapshot(state, snap);
      return this.evaluateWithState(
        state,
        () => Promise.resolve(),
        tabId,
        snap,
        options,
      );
    }
    return withStateTransaction(
      this.stateFile,
      this.stateLock,
      async (state, persist) => {
        const snap = await this.dependencies.snapshot(this.env);
        reconcileSnapshot(state, snap);
        return this.evaluateWithState(state, persist, tabId, snap, options);
      },
    );
  }

  async evaluateWithState(state, persist, tabId, snap, options) {
    let tab = snap.tabs.find((item) => item.tab_id === tabId);
    if (!tab) return null;
    let workspace = snap.workspaces.find(
      (item) => item.workspace_id === tab.workspace_id,
    );
    if (!workspace) return null;

    if (options.resetKind === "tab") {
      state.tabs[tab.tab_id] = resetOwnership(state.tabs[tab.tab_id]);
    }
    if (options.resetKind === "workspace") {
      state.workspaces[workspace.workspace_id] = resetOwnership(
        state.workspaces[workspace.workspace_id],
      );
    }

    let workspaceRecord = state.workspaces[workspace.workspace_id];
    let tabRecord = state.tabs[tab.tab_id];
    let workspaceManual = workspaceRecord?.manual ?? false;
    let tabManual = tabRecord?.manual ?? false;

    if (workspaceManual && tabManual) {
      return {
        dryRun: this.dryRun,
        workspace: workspace.workspace_id,
        tab: tab.tab_id,
        candidate: { workspace: null, tab: null },
        reason: "manual ownership",
        usedModel: false,
        ownership: { workspaceManual, tabManual },
        changes: [],
      };
    }

    const { workspaceName } = await this.workspaceDetails(workspace, snap);
    let tabName = null;
    let reason = tabManual ? "manual tab ownership" : "";
    let usedModel = false;

    if (!tabManual) {
      const details = await this.contextFor(tab, snap, workspaceName);
      const focusedContext = details.paneContexts.find((pane) => pane.focused);
      const hasUserTask = Boolean(focusedContext?.userMessages?.length);
      const heuristic = hasUserTask
        ? null
        : heuristicTitle({ focusedPane: focusedContext });
      if (heuristic && !options.forceModel) {
        tabName = heuristic;
        reason = "process heuristic";
      } else {
        const weakCommandContext = !hasUserTask && !details.focusedPane?.agent;
        const contextReady =
          !weakCommandContext ||
          options.forceModel ||
          options.forceRefresh ||
          observeStableContext(state, tab.tab_id, details.context);
        if (!contextReady) {
          reason = "waiting for stable command context";
        } else {
          const gate = shouldCallModel(state, tab.tab_id, details.context);
          if (gate.allowed || options.forceModel || options.forceRefresh) {
            markModelAttempt(state, tab.tab_id);
            if (!this.dryRun) await persist();
            const suggestion = await this.pi.suggest(details.context);
            markModelSuccess(state, tab.tab_id, details.context);
            tabName = suggestion.tab;
            reason = suggestion.reason;
            usedModel = true;
          } else {
            reason = "unchanged or rate-limited context";
          }
        }
      }
    }

    if (!this.dryRun) {
      const latest = await this.dependencies.snapshot(this.env);
      reconcileSnapshot(state, latest);
      tab = latest.tabs.find((item) => item.tab_id === tabId);
      if (!tab) return null;
      workspace = latest.workspaces.find(
        (item) => item.workspace_id === tab.workspace_id,
      );
      if (!workspace) return null;
      workspaceRecord = state.workspaces[workspace.workspace_id];
      tabRecord = state.tabs[tab.tab_id];
      workspaceManual = workspaceRecord?.manual ?? false;
      tabManual = tabRecord?.manual ?? false;
    }

    const changes = [];
    if (!workspaceManual && workspaceName && workspace.label !== workspaceName) {
      changes.push({
        kind: "workspace",
        id: workspace.workspace_id,
        from: workspace.label,
        to: workspaceName,
      });
    }
    if (!tabManual && tabName && tab.label !== tabName) {
      changes.push({
        kind: "tab",
        id: tab.tab_id,
        from: tab.label,
        to: tabName,
      });
    }

    if (!this.dryRun) {
      for (const change of changes) {
        const collection = change.kind === "tab" ? state.tabs : state.workspaces;
        const previous = { ...collection[change.id] };
        collection[change.id] = prepareRename(collection[change.id], change.to);
        await persist();
        try {
          await this.dependencies.rename(
            change.kind,
            change.id,
            change.to,
            this.env,
          );
        } catch (error) {
          collection[change.id] = previous;
          await persist();
          throw error;
        }
      }
    }

    return {
      dryRun: this.dryRun,
      workspace: workspace.workspace_id,
      tab: tab.tab_id,
      candidate: { workspace: workspaceName, tab: tabName },
      reason,
      usedModel,
      ownership: { workspaceManual, tabManual },
      changes,
    };
  }
}
