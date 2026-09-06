# Goal

Claude Code panes should supply the same bounded user-request evidence Pi panes already supply, so Smart Rename can name them from the actual task instead of process noise.

## Contract

- [Intent](./intent.md)
- [Facts](./facts.md)
- [Fact metadata](./facts.meta.json)
- [Plan](./plan.md)
- [Dev log](./dev-log.md)

## Done when

A recognised Claude pane contributes origin, midpoint, and recent user requests from an allowed transcript path or a unique session-id lookup. Unresolved or empty transcripts keep today's process and output fallback. Pi behaviour stays unchanged. Contained tests cover lookup, sandbox, both JSONL shapes, noise filtering, and the empty fallback. Docs mention Claude Code excerpts.
