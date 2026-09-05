import { randomUUID } from "node:crypto";
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
  type PaneContext,
  type RenameChange,
  type RenameResult,
  type RenameOutcome,
  type SmartRenameState,
} from "./domain.ts";
import {
  focusedPaneContext,
  gitRoot,
  rename,
  siblingPaneContext,
  snapshot,
  tabProgressBase,
  type HerdrPane,
  type HerdrSnapshot,
  type HerdrTab,
  type HerdrWorkspace,
} from "./herdr.ts";
import type { Namer } from "./provider.ts";
import { ModelSourceNamer } from "./model-namer.ts";
import { sanitizeText } from "./text.ts";
import { loadState, statePaths, withStateTransaction } from "./storage.ts";

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

export type ModelActivity = (tab: HerdrTab) => Promise<() => Promise<void>>;

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

interface RenameTarget {
  kind: RenameChange["kind"];
  id: string;
}

function records(state: SmartRenameState, kind: RenameTarget["kind"]) {
  return kind === "pane"
    ? state.panes
    : kind === "tab"
      ? state.tabs
      : state.workspaces;
}

function targetLabel(
  target: RenameTarget,
  snap: HerdrSnapshot,
): string | undefined {
  if (target.kind === "workspace")
    return snap.workspaces.find((w) => w.workspace_id === target.id)?.label;
  if (target.kind === "tab") {
    const label = snap.tabs.find((t) => t.tab_id === target.id)?.label;
    return label === undefined ? undefined : (tabProgressBase(label) ?? label);
  }
  const pane = snap.panes.find((p) => p.pane_id === target.id && p.agent);
  return pane ? (pane.label ?? "") : undefined;
}

function paneIdentity(pane: HerdrPane): string {
  return fingerprint([
    pane.pane_id,
    pane.tab_id,
    pane.workspace_id,
    pane.agent,
    pane.agent_session,
    pane.foreground_cwd ?? pane.cwd,
  ]);
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
    const label = tabProgressBase(tab.label) ?? tab.label;
    state.tabs[tab.tab_id] = reconcileItem(
      state.tabs[tab.tab_id],
      label,
      isDefaultLabel(label, tab.number),
    );
  }
  for (const pane of snap.panes) {
    state.panes[pane.pane_id] = reconcileItem(
      state.panes[pane.pane_id],
      pane.label ?? "",
      isDefaultLabel(pane.label),
    );
  }
  const liveIds = new Set([
    ...snap.workspaces.map((w) => w.workspace_id),
    ...snap.tabs.map((t) => t.tab_id),
    ...snap.panes.map((p) => p.pane_id),
  ]);
  for (const collection of [
    state.workspaces,
    state.tabs,
    state.panes,
    state.modelAttempts,
    state.fingerprints,
    state.pendingFingerprints,
    state.evaluations,
  ]) {
    for (const id of Object.keys(collection)) {
      if (!liveIds.has(id)) delete collection[id];
    }
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
    if (this.#dryRun || !this.#stateFile || !this.#stateLock) {
      return initial ?? this.#dependencies.snapshot(this.#env);
    }
    return withStateTransaction(
      this.#stateFile,
      this.#stateLock,
      async (state) => {
        const current = await this.#dependencies.snapshot(this.#env);
        reconcileSnapshot(state, current);
        return current;
      },
    );
  }

  async close(): Promise<void> {
    await this.#namer.close?.();
  }

  async acknowledge(
    kind: "workspace" | "tab" | "pane",
    id: string,
    label: string,
  ): Promise<void> {
    if (!this.#stateFile || !this.#stateLock) return;
    await withStateTransaction(
      this.#stateFile,
      this.#stateLock,
      async (state) => {
        const current = await this.#dependencies.snapshot(this.#env);
        reconcileSnapshot(state, current);
        // Events can wait behind earlier writes. Never replay an obsolete label.
        if (targetLabel({ kind, id }, current) !== label) return;
        const collection = records(state, kind);
        collection[id] = acknowledgeRename(collection[id], label);
      },
    );
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
    // Only short state/Herdr operations run under the shared lock. Context
    // collection and model latency must not block unrelated tabs or ownership.
    const localState = await loadState(this.#dryRun ? this.#stateFile : null);
    const transaction = async <T>(
      operation: (
        state: SmartRenameState,
        snap: HerdrSnapshot,
        persist: () => Promise<void>,
      ) => Promise<T> | T,
    ): Promise<T> => {
      const run = async (
        state: SmartRenameState,
        persist: () => Promise<void>,
      ) => {
        const snap =
          this.#dryRun && options.snapshot
            ? options.snapshot
            : await this.#dependencies.snapshot(this.#env);
        reconcileSnapshot(state, snap);
        return operation(state, snap, persist);
      };
      return !this.#dryRun && this.#stateFile && this.#stateLock
        ? withStateTransaction(this.#stateFile, this.#stateLock, run)
        : run(localState, async () => {});
    };

    const initial = await transaction((state, snap) => {
      const tab = snap.tabs.find((t) => t.tab_id === tabId);
      const workspace = snap.workspaces.find(
        (w) => w.workspace_id === tab?.workspace_id,
      );
      if (!tab || !workspace) return null;
      const targets: RenameTarget[] = [];
      const scope = options.resetKind;
      if (!scope || scope === "workspace")
        targets.push({ kind: "workspace", id: workspace.workspace_id });
      if (!scope || scope === "tab") targets.push({ kind: "tab", id: tabId });
      if (scope === "pane") {
        const pane = snap.panes.find(
          (p) => p.pane_id === options.targetPaneId && p.tab_id === tabId,
        );
        if (!pane)
          throw new Error("reset-pane requires a pane in the target tab");
        targets.push({ kind: "pane", id: pane.pane_id });
      } else if (!scope) {
        targets.push(
          ...snap.panes
            .filter((p) => p.tab_id === tabId && p.agent)
            .map((p): RenameTarget => ({ kind: "pane", id: p.pane_id })),
        );
      }
      if (scope) {
        for (const target of targets) {
          const collection = records(state, target.kind);
          collection[target.id] = resetOwnership(collection[target.id]);
          state.evaluations[target.id] = randomUUID();
        }
      }
      return { tab, workspace, targets, snap, state: structuredClone(state) };
    });
    if (!initial) return null;
    const { tab, workspace, targets, snap } = initial;
    const result: RenameResult & { outcomes: RenameOutcome[] } = {
      dryRun: this.#dryRun,
      workspace: workspace.workspace_id,
      tab: tabId,
      candidate: { workspace: null, tab: null, panes: {} },
      reason: "no eligible target",
      usedModel: false,
      ownership: {
        workspaceManual:
          initial.state.workspaces[workspace.workspace_id]?.manual ?? false,
        tabManual: initial.state.tabs[tabId]?.manual ?? false,
      },
      changes: [],
      outcomes: [],
    };
    const cache: PaneContextCache = { full: new Map(), sibling: new Map() };
    const suggestions = new Map<string, Promise<NameSuggestion>>();
    // Label ownership controls writes, not whether a pane supplies tab evidence.
    const panes = snap.panes.filter((p) => p.tab_id === tabId);
    let workspaceName: string | undefined;

    for (const target of targets) {
      const outcome: RenameOutcome = {
        ...target,
        status: "skipped",
        reason: "no meaningful task",
      };
      result.outcomes.push(outcome);
      let ticket: string | undefined;
      try {
        if (records(initial.state, target.kind)[target.id]?.manual) {
          outcome.reason = `manual ${target.kind} ownership`;
          continue;
        }
        if (targetLabel(target, snap) === undefined) {
          outcome.reason = "target closed or no longer an agent";
          continue;
        }
        workspaceName ??= (await this.workspaceDetails(workspace, snap))
          .workspaceName;
        let context: NamingContext | undefined;
        let focused: PaneContext | undefined;
        let sourcePanes: HerdrPane[] = [];
        let agent = false;
        if (target.kind === "tab") {
          const details = await this.contextFor(
            tab,
            snap,
            workspaceName,
            panes,
            cache,
          );
          context = details.context;
          focused = details.paneContexts.find((p) => p.focused);
          agent = Boolean(details.focusedPane?.agent);
          sourcePanes = details.focusedPane ? [details.focusedPane] : [];
        } else if (target.kind === "pane") {
          const pane = panes.find((p) => p.pane_id === target.id)!;
          // A pane's task does not depend on naming or inspecting its siblings.
          const details = await this.paneContextFor(
            pane,
            [pane],
            workspaceName,
            cache,
          );
          context = details.context;
          focused = details.paneContexts[0];
          agent = true;
          sourcePanes = [pane];
        }
        if (context && "focusedPane" in context && target.kind === "tab")
          sourcePanes = panes;
        const sourcesStillLive = (latest: HerdrSnapshot) =>
          sourcePanes.every((p) =>
            latest.panes.some(
              (next) =>
                next.pane_id === p.pane_id &&
                paneIdentity(next) === paneIdentity(p),
            ),
          );
        const hasUserTask = Boolean(focused?.userMessages.length);
        const heuristic =
          !hasUserTask && focused
            ? heuristicTitle({ focusedPane: focused })
            : null;
        let label =
          target.kind === "workspace"
            ? workspaceName
            : !options.forceModel
              ? heuristic
              : null;
        let modelSuccess = false;
        const needsModel = target.kind !== "workspace" && !label;

        const claim = await transaction((state, latest) => {
          if (
            targetLabel(target, latest) === undefined ||
            !sourcesStillLive(latest)
          )
            return "target or source changed";
          if (records(state, target.kind)[target.id]?.manual)
            return `manual ${target.kind} ownership`;
          if (
            state.evaluations[target.id] !==
            initial.state.evaluations[target.id]
          ) {
            return "superseded by a newer evaluation";
          }
          if (needsModel && context) {
            if (
              !hasUserTask &&
              !agent &&
              !options.forceModel &&
              !options.forceRefresh &&
              !observeStableContext(state, target.id, context)
            )
              return "waiting for stable command context";
            const gate = shouldCallModel(state, target.id, context);
            if (!gate.allowed && !options.forceModel && !options.forceRefresh)
              return "unchanged or rate-limited context";
            markModelAttempt(state, target.id);
          }
          ticket = randomUUID();
          state.evaluations[target.id] = ticket;
          return null;
        });
        if (claim) {
          outcome.reason = claim;
          continue;
        }

        if (needsModel && context) {
          const key = fingerprint(context);
          let pending = suggestions.get(key);
          if (!pending) {
            const stop =
              target.kind === "tab"
                ? await this.#modelActivity?.(tab)
                : undefined;
            pending = (async () => {
              try {
                return await this.#namer.suggest(context);
              } finally {
                await stop?.();
              }
            })();
            suggestions.set(key, pending);
            result.usedModel = true;
          }
          const suggestion = await pending;
          label = suggestion.tab;
          outcome.reason = suggestion.reason;
          modelSuccess = true;
        } else {
          outcome.reason =
            target.kind === "workspace"
              ? "workspace identity"
              : "process heuristic";
        }

        await transaction(async (state, latest, persist) => {
          result.ownership = {
            workspaceManual:
              state.workspaces[workspace.workspace_id]?.manual ?? false,
            tabManual: state.tabs[tabId]?.manual ?? false,
          };
          const current = targetLabel(target, latest);
          if (current === undefined || !sourcesStillLive(latest)) {
            outcome.reason = "target or source changed";
            return;
          }
          const collection = records(state, target.kind);
          if (collection[target.id]?.manual) {
            outcome.reason = `manual ${target.kind} ownership`;
            return;
          }
          if (state.evaluations[target.id] !== ticket) {
            outcome.reason = "superseded by a newer evaluation";
            return;
          }
          if (target.kind === "workspace") result.candidate.workspace = label;
          else if (target.kind === "tab") result.candidate.tab = label;
          else result.candidate.panes![target.id] = label;
          if (label && label !== current) {
            const change: RenameChange = {
              ...target,
              from: current,
              to: label,
            };
            if (!this.#dryRun) {
              const previous = collection[target.id];
              collection[target.id] = prepareRename(previous, label);
              await persist();
              try {
                await this.#dependencies.rename(
                  target.kind,
                  target.id,
                  label,
                  this.#env,
                );
              } catch (error) {
                if (previous) collection[target.id] = previous;
                else delete collection[target.id];
                await persist();
                throw error;
              }
            }
            result.changes.push(change);
            outcome.status = "renamed";
          } else if (label) {
            outcome.status = "unchanged";
            outcome.reason = `Already named ${label}`;
          }
          if (modelSuccess && context)
            markModelSuccess(state, target.id, context);
        });
      } catch (error) {
        outcome.status = "failed";
        outcome.reason = sanitizeText(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const primary =
      result.outcomes.find((o) => o.kind === (options.resetKind ?? "tab")) ??
      result.outcomes[0];
    result.reason = primary?.reason ?? result.reason;
    return result;
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
  namer = new ModelSourceNamer(env),
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
