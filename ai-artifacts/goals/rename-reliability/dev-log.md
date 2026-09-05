# Smart Rename reliability repair

## 5 September 2026

The repair preserves manual labels, gives explicit actions exact targets, and discards names based on closed or replaced panes.

Worktree: `~/dev/worktrees/herdr-tab-smart-rename/rename-reliability`.
Branch: `fix/rename-reliability`, based on active `main` at `45c994e`.
Related issue: [Smart-name agent panes, #12](https://github.com/iurysza/herdr-tab-smart-rename/issues/12).

## Verified assumptions

- The earlier `feat/pane-smart-renaming` worktree already matched the active implementation except for the Bun launcher and its test. Switching branches alone would not fix the runtime bugs.
- A real `rename-now` returned `manual pane ownership`, no model request, and no changes. The tab was automatic, but its only pane had a manual label.
- The installed Herdr schema defines `pane.updated` as a full `PaneInfo` payload. An unchanged label in this event does not mean the user renamed the pane.
- Six new regression cases failed against the original source: unchanged pane updates, manual-pane tab context, reset-pane scope, independent failure handling, pane closure, and agent-session replacement.
- The installed `TabRenameParams` and `PaneRenameParams` contain no expected-label or revision guard. A final snapshot can reduce the user-edit race, not make the write atomic.
- The private backup had 349 pane ownership records for 30 live panes. Fresh snapshots now remove closed-item ownership and request records.

Private rollback evidence is at `/tmp/smart-rename-reliability.Tb77Lt/`. It contains the pre-repair state, topology snapshot, and installed API schema. It contains no copied provider credentials.

## Changes

- An unchanged pane update preserves ownership. Delayed label events are checked against the live snapshot rather than replayed over newer labels.
- Pane ownership protects its label. It does not exclude the pane's task context from tab naming.
- `rename-now`, `rename-all`, and `reset-tab` affect tabs only. `reset-pane` affects its target agent pane only. `reset-workspace` affects the workspace only.
- Background workspace, tab, and pane decisions succeed or fail independently. Results contain target-specific outcomes, and explicit failures exit nonzero.
- Context collection and model calls run outside the shared state lock. State transactions still protect request gates, expected writes, and rollback.
- Persisted decision IDs reject older context reads and model responses after a newer explicit request. The IDs remain after completion until their targets close.
- Before writing, the service checks target existence, manual ownership, source-pane identity, and decision identity. Moving, closing, or replacing a source pane invalidates its old suggestion.
- The worker handles ownership and closure events separately from model evaluations. Shutdown skips queued event work after stopping begins.
- Fenced JSON permits surrounding prose without relaxing object or label validation. Process hints match command invocations instead of path fragments or terminal prose.
- Every manifest action invokes Bun directly, consistent with declared Windows support.

## Verification

Automated checks:

```sh
bun install --frozen-lockfile
bun run check
bun test
```

Final isolated-HOME result: 52 passed, 3 opt-in live tests skipped, no failures. TypeScript and the production frozen-lockfile install passed. The separate opt-in run passed all 3 live tests. The offline transcript is `/tmp/smart-rename-reliability.Tb77Lt/offline-tests.log`.

The suite covers the original behavior plus closure, replacement, exact action scope, late context reads, concurrent explicit requests, manual edits during inference, stale events, and visible failures.

Opt-in real Herdr checks:

```sh
SMART_RENAME_LIVE_TEST=1 bun test test/herdr-live.test.ts
```

The live tests use disposable background tabs, fixture agent reports, and a local mock provider. They verify:

- the real worker processes a pane-close event before the pending model response is released
- the closed pane's result does not rename its surviving tab
- a surviving pane still receives its own name
- a manual pane label does not prevent a tab rename
- a newer manual tab edit wins over an in-flight suggestion
- the production CLI exits with code 1 for invalid provider output and restores its progress label

All created test tabs are closed in cleanup. No agent process or billed request is used by these tests.

Timing receipts from the last live worker run: first mock request at 1,740 ms, closed-pane state removed at 1,926 ms, whole worker test at 3.85 seconds. Before shutdown skipped queued events, the same test took 13 to 17 seconds. Live-condition waits use the adapter's existing 10-second command deadline. The outer test deadline uses the existing 45-second provider deadline so cleanup has room to finish.

A separate billed OpenAI smoke test succeeded in 3.27 seconds. `openai/gpt-5.6-luna` changed only the caller's tab from `Repair Smart Rename Plugin` to `Update Smart Rename`. Its pane remained `Repair Smart Rename Plugin`, with manual ownership intact.

## Activation and publication

Keep the existing managed plugin link at `~/dev/personal/tools/herdr-tab-smart-rename`. Fast-forward that checkout to the tested repair, then start the worker from that path. Do not replace the user's existing handoff-document edits or `.sem/` files.

No GitHub issue comment or pull request reply is approved by this work. Publishing requires separate approval.

The CLI/setup session at `w5R:p9` owns the later onboarding and model-source integration. Its old setup and review worktrees remain untouched. Wait for the exact committed repair SHA before integrating. The `Namer.suggest(NamingContext)` interface and provider configuration contract are unchanged. Keep the new service outcomes and nonzero failure exits when extending CLI dispatch.

## Remaining limits

- Herdr has no atomic compare-and-set rename. A manual edit between the final snapshot and CLI write remains a narrow race.
- Closing a pane discards its pending suggestion but does not cancel an already-sent provider request.
- Existing manual flags are preserved because their original cause cannot be recovered reliably. `reset-pane` can explicitly reclaim a selected pane.
- Tests ran on macOS. Windows runtime checks require CI on Windows.
- Claude transcript support and log rotation remain separate work. This repair addresses the shared lifecycle failures and the parser and heuristic defects from issue #5, not every item in that issue.
