import {
  acknowledgeRename,
  buildModelContext,
  fingerprint,
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
  type NameSuggestion,
  type NamingContext,
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
  targetPaneId?: string;
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

interface PaneContextCache {
  full: Map<string, Promise<PaneContext>>;
  sibling: Map<string, Promise<PaneContext>>;
}

interface ModelSuccess {
  surfaceId: string;
  context: NamingContext;
}

interface SuggestedLabel {
  label: string | null;
  reason: string;
  usedModel: boolean;
  modelSuccess?: ModelSuccess;
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
  candidates?: readonly HerdrPane[],
): HerdrPane | undefined {
  const panes = candidates
    ? [...candidates]
    : snap.panes.filter((pane) => pane.tab_id === tab.tab_id);
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

  private fullPaneContext(
    pane: HerdrPane,
    cache: PaneContextCache,
  ): Promise<PaneContext> {
    const cached = cache.full.get(pane.pane_id);
    if (cached) return cached;
    const current = this.#dependencies.focusedPaneContext(pane, this.#env);
    cache.full.set(pane.pane_id, current);
    return current;
  }

  private siblingPaneContext(
    pane: HerdrPane,
    cache: PaneContextCache,
  ): Promise<PaneContext> {
    const full = cache.full.get(pane.pane_id);
    if (full) return full;
    const cached = cache.sibling.get(pane.pane_id);
    if (cached) return cached;
    const current = this.#dependencies.siblingPaneContext(pane, this.#env);
    cache.sibling.set(pane.pane_id, current);
    return current;
  }

  private async contextFor(
    tab: HerdrTab,
    snap: HerdrSnapshot,
    workspaceName: string,
    panes: readonly HerdrPane[],
    cache: PaneContextCache,
  ): Promise<{
    focusedPane: HerdrPane | undefined;
    paneContexts: PaneContext[];
    context: ReturnType<typeof buildModelContext>;
  }> {
    const focusedPane = focusedPaneFor(tab, snap, panes);
    const paneContexts: PaneContext[] = [];
    for (const pane of panes) {
      const focused = pane.pane_id === focusedPane?.pane_id;
      const context = focused
        ? await this.fullPaneContext(pane, cache)
        : await this.siblingPaneContext(pane, cache);
      paneContexts.push({ ...context, focused });
    }
    return {
      focusedPane,
      paneContexts,
      context: buildModelContext({ workspaceName, paneContexts }),
    };
  }

  private async paneContextFor(
    targetPane: HerdrPane,
    panes: readonly HerdrPane[],
    workspaceName: string,
    cache: PaneContextCache,
  ): Promise<{
    paneContexts: PaneContext[];
    context: ReturnType<typeof buildModelContext>;
  }> {
    const paneContexts: PaneContext[] = [];
    for (const pane of panes) {
      const focused = pane.pane_id === targetPane.pane_id;
      const context = focused
        ? await this.fullPaneContext(pane, cache)
        : await this.siblingPaneContext(pane, cache);
      paneContexts.push({ ...context, focused });
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
    suggestions: Map<string, Promise<NameSuggestion>>,
    options: EvaluateOptions,
    manualReason = "manual ownership",
    activity?: () => Promise<() => Promise<void>>,
  ): Promise<SuggestedLabel> {
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

    const contextFingerprint = fingerprint(context);
    const cached = suggestions.get(contextFingerprint);
    if (cached) {
      const suggestion = await cached;
      return {
        label: suggestion.tab,
        reason: suggestion.reason,
        usedModel: false,
        modelSuccess: { surfaceId, context },
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
    const pending = this.#namer.suggest(context);
    suggestions.set(contextFingerprint, pending);
    try {
      const suggestion = await pending;
      return {
        label: suggestion.tab,
        reason: suggestion.reason,
        usedModel: true,
        modelSuccess: { surfaceId, context },
      };
    } catch (error) {
      suggestions.delete(contextFingerprint);
      throw error;
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
      const targetPane = snap.panes.find(
        (pane) =>
          pane.pane_id === options.targetPaneId && pane.tab_id === tabId,
      );
      if (!targetPane) {
        throw new Error("reset-pane requires a pane in the target tab");
      }
      state.panes[targetPane.pane_id] = resetOwnership(
        state.panes[targetPane.pane_id],
      );
    }

    let workspaceRecord = state.workspaces[workspace.workspace_id];
    let tabRecord = state.tabs[tab.tab_id];
    let workspaceManual = workspaceRecord?.manual ?? false;
    let tabManual = tabRecord?.manual ?? false;
    const agentPanes = snap.panes.filter(
      (pane) => pane.tab_id === tabId && pane.agent,
    );
    const inspectablePanes = snap.panes.filter(
      (pane) => pane.tab_id === tabId && !state.panes[pane.pane_id]?.manual,
    );
    const automaticAgentPanes = agentPanes.filter(
      (pane) => !state.panes[pane.pane_id]?.manual,
    );

    if (workspaceManual && tabManual && automaticAgentPanes.length === 0) {
      return {
        dryRun: this.#dryRun,
        workspace: workspace.workspace_id,
        tab: tab.tab_id,
        candidate: { workspace: null, tab: null, panes: {} },
        reason: "manual ownership",
        usedModel: false,
        ownership: { workspaceManual, tabManual },
        changes: [],
      };
    }

    const { workspaceName } = await this.workspaceDetails(workspace, snap);
    const contextCache: PaneContextCache = {
      full: new Map(),
      sibling: new Map(),
    };
    const suggestions = new Map<string, Promise<NameSuggestion>>();
    const modelSuccesses: ModelSuccess[] = [];
    let usedModel = false;

    let tabSuggestion: SuggestedLabel;
    if (tabManual) {
      tabSuggestion = {
        label: null,
        reason: "manual tab ownership",
        usedModel: false,
      };
    } else if (inspectablePanes.length === 0) {
      tabSuggestion = {
        label: null,
        reason: "manual pane ownership",
        usedModel: false,
      };
    } else {
      const details = await this.contextFor(
        tab,
        snap,
        workspaceName,
        inspectablePanes,
        contextCache,
      );
      tabSuggestion = await this.suggestLabel(
        state,
        persist,
        tabRecord,
        tab.tab_id,
        details.context,
        details.paneContexts.find((pane) => pane.focused),
        Boolean(details.focusedPane?.agent),
        suggestions,
        options,
        "manual tab ownership",
        () =>
          this.#modelActivity?.(tab!) ??
          Promise.resolve(() => Promise.resolve()),
      );
    }
    const tabName = tabSuggestion.label;
    let reason = tabSuggestion.reason;
    usedModel ||= tabSuggestion.usedModel;
    if (tabSuggestion.modelSuccess) {
      modelSuccesses.push(tabSuggestion.modelSuccess);
    }

    const candidatePanes: Record<string, string | null> = {};
    for (const pane of agentPanes) {
      const paneRecord = state.panes[pane.pane_id];
      if (paneRecord?.manual) {
        candidatePanes[pane.pane_id] = null;
        continue;
      }
      const paneDetails = await this.paneContextFor(
        pane,
        inspectablePanes,
        workspaceName,
        contextCache,
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
        suggestions,
        options,
        "manual pane ownership",
      );
      candidatePanes[pane.pane_id] = suggestion.label;
      usedModel ||= suggestion.usedModel;
      if (suggestion.modelSuccess) {
        modelSuccesses.push(suggestion.modelSuccess);
      }
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

    for (const success of modelSuccesses) {
      markModelSuccess(state, success.surfaceId, success.context);
    }

    return {
      dryRun: this.#dryRun,
      workspace: workspace.workspace_id,
      tab: tab.tab_id,
      candidate: {
        workspace: workspaceName,
        tab: tabName,
        panes: candidatePanes,
      },
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
