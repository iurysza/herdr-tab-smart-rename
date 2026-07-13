# Herdr Smart Rename handoff

Updated: 2026-07-13

## Goal

Keep Herdr workspace and tab labels meaningful without overwriting user-chosen names.

- Workspaces represent stable project/repository identity.
- Tabs represent the task only: 2–4 short words, no agent/model prefix.
- Manual renames always win and remain locked until explicitly reset.
- Kimi runs at low thinking and receives only bounded, sanitized context.

## Current status

Repository: <https://github.com/iurysza/herdr-tab-smart-rename>

Local checkout:

```text
/Users/iurysouza/projects/my-repos/herdr-tab-smart-rename
```

Implementation commits before this handoff document:

```text
main tracks origin/main
91cd1d9 fix: preserve automatic ownership during sweeps
5525394 feat: add context-aware Herdr auto-naming
```

The plugin is locally linked as `autoname`. The corrected worker is running as PID `19749` at handoff time. Treat the PID and Herdr public IDs as ephemeral; verify them instead of reusing them blindly.

Runtime files:

```text
~/.local/state/herdr/plugins/autoname/state.json
~/.local/state/herdr/plugins/autoname/worker.json
~/.local/state/herdr/plugins/autoname/worker.log
```

The runtime directory is mode `0700`; files are mode `0600`.

## Live naming state

Auto-owned tabs at handoff:

| Tab | Current automatic label |
| --- | --- |
| `wZ:tY` | `Repair Ownership For Tabs` |
| `wZ:t0` | `VAR Explainer Components` |
| `w18:t1` | `Task Sync Solution` |

Meaningful pre-existing tabs and all current workspace labels are manual-locked. Examples include `flue-agent-research`, `handoff`, `Kimi · VAR Review`, `pi-tidy-tools`, `skills-audit`, `fue-agent`, `var`, `obsidian-vault`, and `agents`.

Do not rely on those IDs after tabs/workspaces close; Herdr IDs are runtime identifiers.

## Architecture

```text
Herdr lifecycle events ─┐
60-second sweep ────────┴─> serialized worker queue
                               │
                               ├─> reload/reconcile locked state
                               ├─> select stable workspace + focused tab pane
                               ├─> heuristic title when obvious
                               ├─> fresh Pi RPC + Kimi-low when ambiguous
                               ├─> persist expected label
                               └─> rename through Herdr CLI
```

Important files:

| File | Responsibility |
| --- | --- |
| `herdr-plugin.toml` | Six Herdr actions: start, stop, status, rename-now, reset-tab, reset-workspace. |
| `src/cli.mjs` | Action entrypoint and detached singleton lifecycle. |
| `src/worker.mjs` | Event subscription, periodic sweep, serialized work queue, reconnects. |
| `src/service.mjs` | Cross-process state transactions, ownership, evaluation, rename ordering. |
| `src/integrations.mjs` | Herdr CLI/socket framing, safe session-tail reads, Pi RPC. |
| `src/core.mjs` | Naming policy, sanitization, validation, fingerprints, backoff. |
| `src/singleton.mjs` | PID verification and stale lock recovery. |
| `test/` | 20 unit/integration-style regression tests. |

## Findings that shaped the implementation

### Herdr protocol

- Herdr 0.7.3/protocol 16 event envelopes are `{ "event": "...", "data": {...} }`. Reading `message.event.data` silently drops every event.
- `events.subscribe` does not expose generic `pane.output_changed`. A catch-all `pane.output_matched` regex is not a reliable activity stream and becomes noisy/edge-triggered.
- The worker therefore subscribes to global lifecycle events and performs a serialized 60-second sweep for ordinary process/task changes.
- Plugin action invocation uses the bare action ID plus plugin selector:

  ```sh
  herdr plugin action invoke status --plugin autoname
  ```

  `autoname.status --plugin autoname` is invalid in the CLI.

### Pi and Kimi

- `pi --print` is unreliable when spawned by Node with piped stdio. Pi RPC mode is the supported subprocess interface.
- `--no-extensions` disables this machine's `pi-provider-kimi-code` OAuth provider and produces `No API key for provider: kimi-coding`.
- Reusing one RPC process with `new_session` triggered Pi's stale extension-context guard in `session-store`.
- The safe compromise is one fresh Pi RPC process per model request. Calls are already fingerprinted and rate-limited to at most one attempt per tab every ten minutes.
- Failed model attempts record backoff time but not a success fingerprint, so the same task can retry after the backoff window.

### Ownership and races

- State must be serialized across the detached worker and action processes. A file lock wraps full state transactions.
- The expected label is persisted before calling Herdr rename.
- Matching rename events are idempotent; duplicate matching events do not turn an automatic label into a manual lock.
- Unmatched events or observed-label changes mark the item manual.
- The first live worker reused one stale snapshot across a multi-tab sweep. A later tab evaluation saw an old label and misclassified AutoName's own rename as manual. Each tab evaluation now fetches a fresh snapshot.
- Explicit `reset-tab` bypasses stale model backoff so users can immediately re-enable automatic naming.

### Privacy and robustness

- Serialized model context is hard-capped at 4,500 characters.
- Only the focused detected Pi pane may contribute session user messages.
- Pi session reads are restricted to regular files under the configured Pi sessions root and to a 512 KiB tail.
- Sibling panes contribute bounded process summaries only.
- Common credentials are redacted on a best-effort basis; this is not a universal secret detector.
- Manual-locked tabs skip pane/session reads and model calls entirely.
- State locks recover stale/dead owners. Worker PID verification requires the exact absolute worker path before sending a signal.

## Validation completed

```sh
npm run check
npm test
```

Latest result: 20/20 tests passed.

Also verified:

- manifest parses and links under Herdr 0.7.3;
- all six plugin actions register;
- stopped/running status actions exit successfully;
- live Kimi OAuth dry-run returns a valid candidate;
- worker start/stop/restart works;
- runtime state permissions are private;
- manual labels remained unchanged during activation;
- automatic ownership was repaired and confirmed in `state.json` after the stale-snapshot fix.

## Operations

```sh
# Status
herdr plugin action invoke status --plugin autoname

# Start
herdr plugin action invoke start --plugin autoname

# Stop
herdr plugin action invoke stop --plugin autoname

# Current action logs
herdr plugin log list --plugin autoname --limit 10

# Non-mutating candidate from a Herdr pane
cd ~/projects/my-repos/herdr-tab-smart-rename
node src/cli.mjs dry-run
```

`rename-now`, `reset-tab`, and `reset-workspace` are available through Herdr's action picker. Reset actions intentionally allow AutoName to own that item again.

## Remaining risks and follow-up

1. Observe at least one real task transition after the ten-minute model window and confirm the 60-second sweep updates only auto-owned tabs.
2. Manually rename one auto-owned tab, then verify `state.json` marks it manual and later sweeps leave it untouched.
3. Worker logs are not rotated.
4. Closed tab/workspace records are not pruned from state.
5. Remote and named multi-session socket discovery is not automatic; the worker uses the socket inherited by the start action.
6. Fresh Pi startup adds latency to rare model calls. Do not optimize this back to persistent `new_session` without addressing extension stale-context behavior.
7. No CI workflow, release tag, or license has been added yet. Decide these deliberately before publishing a formal release.
8. Model quality is heuristic. Prefer evidence from live labels before expanding taxonomy or adding configuration.

## Recommended next session

Start with observation, not refactoring:

1. Read this file and `README.md`.
2. Confirm worker health and inspect only new worker-log lines.
3. Verify one periodic task transition and one manual-override transition.
4. Fix only reproduced issues.
5. Run the full test suite before committing and pushing.
