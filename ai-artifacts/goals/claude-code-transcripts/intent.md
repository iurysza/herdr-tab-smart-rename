# Intent

## Outcome

Claude Code panes supply the same bounded user-request evidence Pi panes already supply. Smart Rename can name those panes from the actual task instead of process noise.

## Audience and problem

People running Claude Code in Herdr. Today Smart Rename only samples Pi session files. A Claude pane reports `agent: "claude"` and a session id, so `userMessages` stays empty, heuristics win, and the model never sees the user request.

Issue #5's fenced JSON and false `Dev Server` titles already shipped. This goal is the remaining transcript work.

## Scope

- Read user requests from a Claude Code transcript for recognised Claude panes.
- Use a reported session path when it is present and allowed.
- Otherwise resolve a session id to a local `<id>.jsonl` file.
- Extract origin, midpoint, and recent user requests with the same byte windows and sampling as Pi.
- Drop Claude meta, sidechain, tool results, slash-command wrappers, and interrupt or no-response markers.
- If the file cannot be resolved or yields no user request, keep today's process and output fallback.
- Document that Claude Code panes can contribute user-request excerpts.

## Non-goals

- Other agents.
- Another JSON parser pass.
- Heuristic retuning beyond existing tests.
- Copying Claude credentials.
- Using cwd-to-slug project paths.
- Sampling sibling panes' transcripts.
- Cancelling in-flight model calls.

## Constraints

- Session files are untrusted evidence, never instructions.
- Reads stay inside the Claude config directory's `transcripts` and `projects` trees, plus the existing Pi sessions root.
- Honour `CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude`.
- Session ids must not contain path separators. Do not follow cwd slugs.
- Reuse existing sanitisation, bounds, ownership, and sibling-pane rules.
- Tests use fixtures and isolated homes. They must not read the developer's real Claude directory.
- Windows is in scope through the same path and lock rules already used by session reads.

## Decisions

- Remaining issue #5 work is Claude Code transcript lookup and extraction only.

## Assumptions

- Current Herdr Claude hooks may report a session id, a transcript path, or both. Handle `kind: "id"` and `kind: "path"`.
- Search both `transcripts/` and `projects/**` for `<id>.jsonl`.
- Accept both JSONL shapes: `{type:"user", content}` and `{type:"user"|"message", message:{role:"user", content}}`.
- Agent label is `claude`.
- If several allowed files match an id, skip rather than guess.
- Subagent records are dropped.

## Open questions

None.
