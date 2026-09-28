# Architecture

Smart Rename is a Herdr plugin that names workspaces, tabs, and agent panes. The worker handles background naming; plugin actions handle explicit renames, setup, and worker control. Both entry points use the same service for naming. The [domain glossary](CONTEXT.md) distinguishes the label being changed from the pane supplying evidence.

## Where control enters

[herdr-plugin.toml](../herdr-plugin.toml) registers actions, setup overlays, and the Bun dependency install. [src/cli.ts](../src/cli.ts) dispatches actions. `start` launches a detached [src/worker.ts](../src/worker.ts) and waits for it to mark the current Herdr socket ready. A live worker serving a different socket blocks another start; `status` reports which session it serves.

The worker subscribes to Herdr lifecycle events through [src/herdr.ts](../src/herdr.ts). Rename events update ownership immediately. Other relevant events schedule an evaluation after 400 ms; a 60-second sweep catches changes without a matching event. Event handling and evaluations run separately, so a model call does not hold up ownership events. The worker evaluates up to three tabs at once, but only one evaluation per tab. [src/model-namer.ts](../src/model-namer.ts) serializes model requests so concurrent evaluations cannot close each other's model source. On socket closure, the worker reconnects; on shutdown, it drains queued work and removes only its own worker record. See [src/worker.ts](../src/worker.ts) and [src/storage.ts](../src/storage.ts).

## How a label is chosen

[src/service.ts](../src/service.ts) reconciles a fresh Herdr snapshot with persisted ownership before deciding what to name. Background evaluations consider the workspace, tab, and recognized agent panes. Explicit actions restrict the target: `rename-now` and `reset-tab` affect the tab, `reset-pane` affects one pane, and `reset-workspace` affects the workspace. `rename-all` evaluates up to three tabs at once. An explicit action clears manual ownership for its target; the worker does not.

For a tab, `focusedPaneFor` prefers the focused agent, then an active agent, then another pane. The service reads full context from that pane and process summaries from siblings. A pane label uses only that pane's context. The workspace candidate uses the worktree repository name, an existing non-default label, a Git root, or a pane directory in that order. These choices are in [src/service.ts](../src/service.ts) and [src/domain.ts](../src/domain.ts).

```text
Herdr snapshot + ownership
          |
          v
eligible target
          |
          +--> workspace identity -> workspace candidate
          +--> source pane + known command -> fixed task label
          +--> source pane + other task    -> bounded context -> selected model
                                                    |
                                                    v
                                       validate and recheck -> Herdr rename
```

`heuristicTitle` names known commands such as test runs without a model call, but a user request takes precedence over that shortcut. For other tasks, `buildModelContext` prefers sampled user requests from a recognized Pi or Claude Code session. Without requests, it uses process and terminal evidence. The context is sanitized and capped at 4,500 JSON characters; redaction is best-effort. See [src/herdr.ts](../src/herdr.ts), [src/pi-context.ts](../src/pi-context.ts), [src/text.ts](../src/text.ts), and [privacy guidance](../docs/configuration.md#private-files-and-context).

For Pi and Claude Code panes, background naming waits for the first user request before calling a model. For a non-agent command without user requests, it waits for the same context twice. Normal evaluations skip unchanged successful context. A new agent session can get its first task name after a short gap instead of waiting ten minutes; command-only context keeps the ten-minute limit. An abstention waits for changed context, while failed calls retry with increasing delays up to ten minutes. Explicit refreshes bypass these gates. See `observeStableContext`, `shouldCallModel`, and `evaluate` in [src/domain.ts](../src/domain.ts) and [src/service.ts](../src/service.ts).

## Model and configuration boundary

[src/model-selection.ts](../src/model-selection.ts) loads `model-selection.json` before each model-backed rename. If it is absent, Direct is selected. [src/model-namer.ts](../src/model-namer.ts) routes to Direct or the selected Pi or OpenCode adapter, without falling back to another source on failure. Selection stores the source, provider, model, and optional profile, not a key. [src/setup.ts](../src/setup.ts) discovers choices and validates configuration before starting the worker; [src/setup-transaction.ts](../src/setup-transaction.ts) restores prior settings if a save or validation fails.

- **Direct:** [src/provider.ts](../src/provider.ts) reads private `provider.env` settings and the naming prompt for each request, then uses an OpenAI-compatible endpoint through the AI SDK.
- **Pi:** [src/model-sources/pi.ts](../src/model-sources/pi.ts) uses Pi's model runtime for a completion, without starting a Pi agent or its tools.
- **OpenCode:** [src/model-sources/opencode.ts](../src/model-sources/opencode.ts) starts a local server and a temporary session, denies tool execution, then attempts to delete the session and close the server. OpenCode may still show tool definitions to the provider.

The common output decoder in [src/effect/model-output.ts](../src/effect/model-output.ts) and label rules in [src/domain.ts](../src/domain.ts) reject malformed or invalid suggestions. An invalid model response or source failure is reported as a failed outcome, not a provider switch. `check-ai` validates selection and prompt but does not make a completion. Private configuration is separate from the plugin checkout; [configuration and controls](../docs/configuration.md) lists its files and precedence.

## Why a late result cannot rename an old task

[src/storage.ts](../src/storage.ts) serializes short state transactions across the worker and CLI. Context reads and model requests happen outside the lock. Before a request, `evaluate` claims a decision ID for the target. Before writing the result, it reads a fresh snapshot and checks target existence, manual ownership, source-pane identity, and that the decision ID is still current. A closed pane, changed agent session, manual rename, or newer evaluation discards the older result. The service persists an expected label before calling Herdr and restores the previous ownership record if the rename command fails.

These checks do not make the Herdr rename atomic with the final snapshot: a manual edit between that check and the CLI write can still race. Pane closure discards a stale result but does not cancel a model request already sent. During model-backed naming, [src/herdr.ts](../src/herdr.ts) marks the tab and, for pane naming, the pane as in progress. It restores only its own marker if the label has not changed. The worker ignores marker events so they do not acquire manual ownership.

The code entry points and tests for each behavior are listed in the [code map](SEMANTIC_MAP.md). For safe local checks, see the [development guide](../docs/development.md). The bundled [naming policy](../docs/naming-policy.md) is also the runtime's default model prompt, so edits to that file change behavior.
