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
  type OwnershipRecord,
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
    kind: "workspace" | "tab" | "pane",
    id: string,
    label: string,
    env?: NodeJS.ProcessEnv,
  ): Promise<void>;
}

export interface EvaluateOptions {
  snapshot?: HerdrSnapshot;
  resetKind?: "workspace" | "tab" | "pane" | null;
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
  for (const pane of snap.panes) {
    state.panes[pane.pane_id] = reconcileItem(
      state.panes[pane.pane_id],
      pane.label ?? "",
      isDefaultLabel(pane.label),
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
    kind: "workspace" | "tab" | "pane",
    id: string,
    label: string,
  ): Promise<void> {
    if (!this.#stateFile || !this.#stateLock) return;
    await withStateTransaction(this.#stateFile, this.#stateLock, (state) => {
      const collection =
        kind === "pane"
          ? state.panes
          : kind === "tab"
            ? state.tabs
            : state.workspaces;
      collection[id] = acknowledgeRename(collection[id], label);
    });
  }

  private async contextFor(
    tab: HerdrTab,
    snap: HerdrSnapshot,
    workspaceName: string,
  ): Promise<{
    focusedPane: HerdrPane | undefined;
    panes: HerdrPane[];
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
      panes,
      paneContexts,
      context: buildModelContext({ workspaceName, paneContexts }),
    };
  }

  private async paneContextFor(
    targetPane: HerdrPane,
    snap: HerdrSnapshot,
    workspaceName: string,
    options: {
      focusedPaneId?: string | undefined;
      focusedContext?: PaneContext | undefined;
    } = {},
  ): Promise<{
    paneContexts: PaneContext[];
    context: ReturnType<typeof buildModelContext>;
  }> {
    const panes = snap.panes.filter((pane) => pane.tab_id === targetPane.tab_id);
    const paneContexts: PaneContext[] = [];
    for (const pane of panes) {
      const isTarget = pane.pane_id === targetPane.pane_id;
      const cached =
        isTarget && pane.pane_id === options.focusedPaneId
          ? options.focusedContext
          : undefined;
      const full =
        cached ??
        (pane.agent
          ? await this.#dependencies.focusedPaneContext(pane, this.#env)
          : await this.#dependencies.siblingPaneContext(pane, this.#env));
      paneContexts.push({
        ...full,
        focused: isTarget,
      });
    }
    return {
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

  private async suggestLabel(
    state: SmartRenameState,
    persist: () => Promise<void>,
    record: OwnershipRecord | undefined,
    surfaceId: string,
    context: ReturnType<typeof buildModelContext>,
    focusedContext: PaneContext | undefined,
    isAgentSurface: boolean,
    options: EvaluateOptions,
    manualReason = "manual ownership",
    activity?: () => Promise<() => Promise<void>>,
  ): Promise<{ label: string | null; reason: string; usedModel: boolean }> {
    if (record?.manual) {
      return { label: null, reason: manualReason, usedModel: false };
    }
    const hasUserTask = Boolean(focusedContext?.userMessages.length);
    const heuristic = hasUserTask
      ? null
      : heuristicTitle(focusedContext ? { focusedPane: focusedContext } : {});
    if (heuristic && !options.forceModel) {
      return {
        label: heuristic,
        reason: "process heuristic",
        usedModel: false,
      };
    }
    const weakCommandContext = !hasUserTask && !isAgentSurface;
    const contextReady =
      !weakCommandContext ||
      options.forceModel ||
      options.forceRefresh ||
      observeStableContext(state, surfaceId, context);
    if (!contextReady) {
      return {
        label: null,
        reason: "waiting for stable command context",
        usedModel: false,
      };
    }
    const gate = shouldCallModel(state, surfaceId, context);
    if (!gate.allowed && !options.forceModel && !options.forceRefresh) {
      return {
        label: null,
        reason: "unchanged or rate-limited context",
        usedModel: false,
      };
    }
    markModelAttempt(state, surfaceId);
    if (!this.#dryRun) await persist();
    const stopActivity = activity ? await activity() : undefined;
    try {
      const suggestion = await this.#namer.suggest(context);
      markModelSuccess(state, surfaceId, context);
      return {
        label: suggestion.tab,
        reason: suggestion.reason,
        usedModel: true,
      };
    } finally {
      await stopActivity?.();
    }
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
    if (options.resetKind === "pane") {
      for (const pane of snap.panes.filter((item) => item.tab_id === tabId)) {
        state.panes[pane.pane_id] = resetOwnership(state.panes[pane.pane_id]);
      }
    }

    let workspaceRecord = state.workspaces[workspace.workspace_id];
    let tabRecord = state.tabs[tab.tab_id];
    let workspaceManual = workspaceRecord?.manual ?? false;
    let tabManual = tabRecord?.manual ?? false;

    const { workspaceName } = await this.workspaceDetails(workspace, snap);
    let usedModel = false;

    const details = await this.contextFor(tab, snap, workspaceName);
    const tabSuggestion = tabManual
      ? {
          label: null as string | null,
          reason: "manual tab ownership",
          usedModel: false,
        }
      : await this.suggestLabel(
          state,
          persist,
          tabRecord,
          tab.tab_id,
          details.context,
          details.paneContexts.find((pane) => pane.focused),
          Boolean(details.focusedPane?.agent),
          options,
          "manual tab ownership",
          () =>
            this.#modelActivity?.(tab!) ??
            Promise.resolve(() => Promise.resolve()),
        );
    let tabName = tabSuggestion.label;
    let reason = tabSuggestion.reason;
    usedModel ||= tabSuggestion.usedModel;

    const candidatePanes: Record<string, string | null> = {};
    const agentPanes = snap.panes.filter(
      (pane) => pane.tab_id === tabId && pane.agent,
    );
    const focusedPaneId = details.focusedPane?.pane_id;
    const focusedContext = focusedPaneId
      ? details.paneContexts.find(
          (context, index) =>
            details.panes[index]!.pane_id === focusedPaneId,
        )
      : undefined;
    for (const pane of agentPanes) {
      const paneRecord = state.panes[pane.pane_id];
      const paneDetails = await this.paneContextFor(
        pane,
        snap,
        workspaceName,
        { focusedPaneId, focusedContext },
      );
      const paneFocusedContext = paneDetails.paneContexts.find(
        (context) => context.focused,
      );
      const suggestion = await this.suggestLabel(
        state,
        persist,
        paneRecord,
        pane.pane_id,
        paneDetails.context,
        paneFocusedContext,
        Boolean(pane.agent),
        options,
        "manual pane ownership",
      );
      candidatePanes[pane.pane_id] = suggestion.label;
      usedModel ||= suggestion.usedModel;
    }

    if (!this.#dryRun) {
      const latest = await this.#dependencies.snapshot(this.#env);
      reconcileSnapshot(state, latest);
      snap = latest;
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
    if (
      !workspaceManual &&
      workspaceName &&
      workspace.label !== workspaceName
    ) {
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
    for (const pane of snap.panes.filter(
      (pane) => pane.tab_id === tabId && pane.agent,
    )) {
      const paneName = candidatePanes[pane.pane_id];
      if (
        !state.panes[pane.pane_id]?.manual &&
        paneName &&
        paneName !== (pane.label ?? "")
      ) {
        changes.push({
          kind: "pane",
          id: pane.pane_id,
          from: pane.label ?? "",
          to: paneName,
        });
      }
    }

    if (!this.#dryRun) {
      for (const change of changes) {
        const collection =
          change.kind === "workspace"
            ? state.workspaces
            : change.kind === "tab"
              ? state.tabs
              : state.panes;
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
      candidate: { workspace: workspaceName, tab: tabName, panes: candidatePanes },
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
