import {
  acknowledgeRename,
  buildModelContext,
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
  type PaneContext,
  type RenameChange,
  type RenameResult,
  type SmartRenameState,
} from "./domain.ts";
import {
  focusedPaneContext,
  gitRoot,
  rename,
  siblingPaneContext,
  snapshot,
  type HerdrPane,
  type HerdrSnapshot,
  type HerdrTab,
  type HerdrWorkspace,
} from "./herdr.ts";
import { AiSdkNamer, type Namer } from "./provider.ts";
import {
  loadState,
  statePaths,
  withStateTransaction,
} from "./storage.ts";

export interface ServiceDependencies {
  snapshot(env?: NodeJS.ProcessEnv): Promise<HerdrSnapshot>;
  gitRoot(cwd?: string): Promise<string | null>;
  focusedPaneContext(
    pane: HerdrPane,
    env?: NodeJS.ProcessEnv,
  ): Promise<PaneContext>;
  siblingPaneContext(
    pane: HerdrPane,
    env?: NodeJS.ProcessEnv,
  ): Promise<PaneContext>;
  rename(
    kind: "workspace" | "tab",
    id: string,
    label: string,
    env?: NodeJS.ProcessEnv,
  ): Promise<void>;
}

export interface EvaluateOptions {
  snapshot?: HerdrSnapshot;
  resetKind?: "workspace" | "tab" | null;
  forceModel?: boolean;
  forceRefresh?: boolean;
}

export type ModelActivity = (
  tab: HerdrTab,
) => Promise<() => Promise<void>>;

interface ServiceOptions {
  stateFile?: string | null;
  stateLock?: string | null;
  namer: Namer;
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
  modelActivity?: ModelActivity;
  dependencies?: Partial<ServiceDependencies>;
}

const defaultDependencies: ServiceDependencies = {
  snapshot,
  gitRoot,
  focusedPaneContext,
  siblingPaneContext,
  rename,
};

export function focusedPaneFor(
  tab: HerdrTab,
  snap: HerdrSnapshot,
): HerdrPane | undefined {
  const panes = snap.panes.filter((pane) => pane.tab_id === tab.tab_id);
  const layout = snap.layouts.find((item) => item.tab_id === tab.tab_id);
  const id = layout?.focused_pane_id ?? snap.focused_pane_id;
  const focused = panes.find((pane) => pane.pane_id === id);
  return (
    (focused?.agent ? focused : undefined) ??
    panes.find(
      (pane) =>
        pane.agent && ["working", "blocked"].includes(pane.agent_status ?? ""),
    ) ??
    focused ??
    panes[0]
  );
}

export function reconcileSnapshot(
  state: SmartRenameState,
  snap: HerdrSnapshot,
): SmartRenameState {
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

export class AutoNameService {
  readonly #stateFile: string | null;
  readonly #stateLock: string | null;
  readonly #namer: Namer;
  readonly #env: NodeJS.ProcessEnv;
  readonly #dryRun: boolean;
  readonly #modelActivity: ModelActivity | undefined;
  readonly #dependencies: ServiceDependencies;

  constructor({
    stateFile = null,
    stateLock = null,
    namer,
    env = process.env,
    dryRun = false,
    modelActivity,
    dependencies = {},
  }: ServiceOptions) {
    this.#stateFile = stateFile;
    this.#stateLock = stateLock;
    this.#namer = namer;
    this.#env = env;
    this.#dryRun = dryRun;
    this.#modelActivity = modelActivity;
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  async initialize(initial?: HerdrSnapshot | null): Promise<HerdrSnapshot> {
    const current = initial ?? (await this.#dependencies.snapshot(this.#env));
    if (this.#dryRun || !this.#stateFile || !this.#stateLock) return current;
    await withStateTransaction(this.#stateFile, this.#stateLock, (state) => {
      reconcileSnapshot(state, current);
    });
    return current;
  }

  async acknowledge(
    kind: "workspace" | "tab",
    id: string,
    label: string,
  ): Promise<void> {
    if (!this.#stateFile || !this.#stateLock) return;
    await withStateTransaction(this.#stateFile, this.#stateLock, (state) => {
      const collection = kind === "tab" ? state.tabs : state.workspaces;
      collection[id] = acknowledgeRename(collection[id], label);
    });
  }

  private async contextFor(
    tab: HerdrTab,
    snap: HerdrSnapshot,
    workspaceName: string,
  ): Promise<{
    focusedPane: HerdrPane | undefined;
    paneContexts: PaneContext[];
    context: ReturnType<typeof buildModelContext>;
  }> {
    const focusedPane = focusedPaneFor(tab, snap);
    const panes = snap.panes.filter((pane) => pane.tab_id === tab.tab_id);
    const paneContexts: PaneContext[] = [];
    for (const pane of panes) {
      paneContexts.push(
        pane.pane_id === focusedPane?.pane_id
          ? await this.#dependencies.focusedPaneContext(pane, this.#env)
          : await this.#dependencies.siblingPaneContext(pane, this.#env),
      );
    }
    return {
      focusedPane,
      paneContexts,
      context: buildModelContext({ workspaceName, paneContexts }),
    };
  }

  private async workspaceDetails(
    workspace: HerdrWorkspace,
    snap: HerdrSnapshot,
  ): Promise<{ stablePane: HerdrPane | undefined; workspaceName: string }> {
    const stablePane = snap.panes.find(
      (pane) => pane.workspace_id === workspace.workspace_id,
    );
    const needsFallback =
      !workspace.worktree?.repo_name &&
      isDefaultLabel(workspace.label, workspace.number);
    const root = needsFallback
      ? await this.#dependencies.gitRoot(
          stablePane?.foreground_cwd ?? stablePane?.cwd,
        )
      : null;
    return {
      stablePane,
      workspaceName: workspaceCandidate(workspace, stablePane, root),
    };
  }

  async evaluateAll(
    initial?: HerdrSnapshot | null,
    options: EvaluateOptions = {},
  ): Promise<RenameResult[]> {
    const snap = initial ?? (await this.#dependencies.snapshot(this.#env));
    const results: RenameResult[] = [];
    for (const tab of snap.tabs) {
      const result = await this.evaluate(tab.tab_id, options);
      if (result) results.push(result);
    }
    return results;
  }

  async evaluate(
    tabId: string,
    options: EvaluateOptions = {},
  ): Promise<RenameResult | null> {
    if (this.#dryRun || !this.#stateFile || !this.#stateLock) {
      const snap =
        options.snapshot ?? (await this.#dependencies.snapshot(this.#env));
      const state = await loadState(this.#stateFile);
      reconcileSnapshot(state, snap);
      return this.evaluateWithState(
        state,
        async () => {},
        tabId,
        snap,
        options,
      );
    }
    return withStateTransaction(
      this.#stateFile,
      this.#stateLock,
      async (state, persist) => {
        const snap = await this.#dependencies.snapshot(this.#env);
        reconcileSnapshot(state, snap);
        return this.evaluateWithState(state, persist, tabId, snap, options);
      },
    );
  }

  private async evaluateWithState(
    state: SmartRenameState,
    persist: () => Promise<void>,
    tabId: string,
    snap: HerdrSnapshot,
    options: EvaluateOptions,
  ): Promise<RenameResult | null> {
    let tab = snap.tabs.find((item) => item.tab_id === tabId);
    if (!tab) return null;
    let workspace = snap.workspaces.find(
      (item) => item.workspace_id === tab!.workspace_id,
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
        dryRun: this.#dryRun,
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
    let tabName: string | null = null;
    let reason = tabManual ? "manual tab ownership" : "";
    let usedModel = false;

    if (!tabManual) {
      const details = await this.contextFor(tab, snap, workspaceName);
      const focusedContext = details.paneContexts.find((pane) => pane.focused);
      const hasUserTask = Boolean(focusedContext?.userMessages.length);
      const heuristic = hasUserTask
        ? null
        : heuristicTitle(focusedContext ? { focusedPane: focusedContext } : {});
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
            if (!this.#dryRun) await persist();
            const stopActivity = await this.#modelActivity?.(tab);
            try {
              const suggestion = await this.#namer.suggest(details.context);
              markModelSuccess(state, tab.tab_id, details.context);
              tabName = suggestion.tab;
              reason = suggestion.reason;
              usedModel = true;
            } finally {
              await stopActivity?.();
            }
          } else {
            reason = "unchanged or rate-limited context";
          }
        }
      }
    }

    if (!this.#dryRun) {
      const latest = await this.#dependencies.snapshot(this.#env);
      reconcileSnapshot(state, latest);
      tab = latest.tabs.find((item) => item.tab_id === tabId);
      if (!tab) return null;
      workspace = latest.workspaces.find(
        (item) => item.workspace_id === tab!.workspace_id,
      );
      if (!workspace) return null;
      workspaceRecord = state.workspaces[workspace.workspace_id];
      tabRecord = state.tabs[tab.tab_id];
      workspaceManual = workspaceRecord?.manual ?? false;
      tabManual = tabRecord?.manual ?? false;
    }

    const changes: RenameChange[] = [];
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

    if (!this.#dryRun) {
      for (const change of changes) {
        const collection =
          change.kind === "tab" ? state.tabs : state.workspaces;
        const previous = collection[change.id];
        collection[change.id] = prepareRename(previous, change.to);
        await persist();
        try {
          await this.#dependencies.rename(
            change.kind,
            change.id,
            change.to,
            this.#env,
          );
        } catch (error) {
          if (previous) collection[change.id] = previous;
          else delete collection[change.id];
          await persist();
          throw error;
        }
      }
    }

    return {
      dryRun: this.#dryRun,
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

interface CompositionOptions {
  stateDir?: string | null;
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
  namer?: Namer;
  modelActivity?: ModelActivity;
  dependencies?: Partial<ServiceDependencies>;
}

export function createService({
  stateDir = null,
  env = process.env,
  dryRun = false,
  namer = new AiSdkNamer(env),
  modelActivity,
  dependencies = {},
}: CompositionOptions = {}): AutoNameService {
  const paths = stateDir ? statePaths(stateDir) : null;
  return new AutoNameService({
    stateFile: paths?.state ?? null,
    stateLock: paths?.stateLock ?? null,
    namer,
    env,
    dryRun,
    ...(modelActivity ? { modelActivity } : {}),
    dependencies,
  });
}
