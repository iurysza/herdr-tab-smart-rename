# Plan

Extend the existing session reader. Do not add a second namer, a Claude-specific service path, or cwd-slug lookup.

`focusedPaneContext` in `src/herdr.ts` currently samples only `agent === "pi"` with `kind === "path"`. Claude panes therefore send empty `userMessages`, so `hasUserTask` in `src/service.ts` is false and heuristics win. The service already treats any focused pane with user messages the same way. Filling those messages is enough.

## Approach

Keep byte windows, origin/mid/recent sampling, and `realpath` containment in `src/pi-context.ts`. Teach that file to accept more than one allowed root, parse Claude JSONL, and resolve a session id. Keep `src/herdr.ts` as the pane switch: Pi path, Claude path, or Claude id.

Claude config dir is `CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude`. Allowed roots are that directory's `transcripts` and `projects` folders. Pi keeps its existing sessions root.

Id lookup checks `transcripts/<id>.jsonl`, then `projects/*/<id>.jsonl`. No cwd slug. If the id contains a path separator or is otherwise not a single filename, skip. If more than one allowed file matches, skip.

## Steps

### 1. Resolve and sandbox Claude session files

Files: `src/pi-context.ts`

- Allow `openSession` to accept a list of roots instead of only the Pi sessions root.
- Add Claude root helpers and `paneSessionPath({ agent, agent_session }, env)`.
- Pi: `kind === "path"` under the Pi sessions root, unchanged.
- Claude path: read only when `kind === "path"` and the file is under a Claude root.
- Claude id: resolve as above, then apply the same file and containment checks.

Verify: fixture tests for allowed path, path outside roots, missing file, `..` in the id, duplicate project matches, `CLAUDE_CONFIG_DIR`, and `transcripts/<id>.jsonl`. Facts 2, 3, 4, 8, 9.

### 2. Extract user requests from both JSONL shapes

Files: `src/pi-context.ts`

Widen record parsing so a line can be:

- `{ type: "message", message: { role: "user", content } }` (Pi)
- `{ type: "user" | "message", message: { role: "user", content } }` (older Claude projects)
- `{ type: "user", content }` (current Claude transcripts)

Drop before sampling:

- `isMeta` or `isSidechain`
- `tool_use` / `tool_result`
- slash-command and local-command wrappers
- `[Request interrupted by user]` and `[No response requested]`
- empty text after stripping `<system-reminder>` blocks

Keep the same head/middle/tail windows and origin/mid/recent selection.

Verify: fixture JSONL for both shapes, wrapper-only files that yield no messages, and mixed files that keep the real user lines. Facts 1, 5, 6, 7, 9.

### 3. Wire Claude panes into focused context

Files: `src/herdr.ts`

Replace the Pi-only path ternary with `paneSessionPath`. Sibling panes still return empty `userMessages`.

Verify: a Claude pane with a fixture transcript produces the same `sessionMessages` shape as Pi. A Claude pane with an unresolvable id has empty user messages so heuristics can still run. Pi path tests stay green. Facts 1, 5, 8.

### 4. Tests

Files: `test/context.test.ts`

Cover path reads, id lookup, sandbox rejection, both JSONL shapes, noise filtering, empty fallback, and unchanged Pi behaviour. Use `mkdtemp` homes. Do not read `~/.claude`.

Run:

```sh
bun run check
bun scripts/test-contained.ts
```

Facts 8 and 9, plus every fact marked `automatedVerification: true`.

### 5. Docs

Files: `docs/configuration.md`, `docs/naming-policy.md`, `README.md`, `ai-artifacts/ARCHITECTURE.md`, `ai-artifacts/SEMANTIC_MAP.md`

Say that Claude Code panes can contribute short user-request excerpts, with the same bounds and sanitisation as Pi. Update the code map row for `src/pi-context.ts`.

Fact 10.

## Risks

- Claude may add another JSONL shape. Unknown records stay ignored; naming falls back.
- A large `projects` tree could make id lookup slow. Limit the walk to `transcripts/<id>.jsonl` and one directory level under `projects`.
- Herdr may report id even when a transcript path exists. Id lookup still works for that case.

## Assumptions

Listed in [intent.md](./intent.md). No extra ones.

## Unknowns

None that block this plan.
