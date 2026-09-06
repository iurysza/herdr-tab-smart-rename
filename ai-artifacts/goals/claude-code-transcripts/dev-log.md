# Dev Log

Status: Implemented, contained tests passing

## 6 September 2026

Claude Code panes now resolve a session path or unique `<id>.jsonl` under `CLAUDE_CONFIG_DIR`/`~/.claude` `transcripts` and `projects`, then reuse the existing origin/mid/recent sampler. Wrapper, meta, sidechain, and tool records are dropped. Pi roots and sibling panes are unchanged.

Changed files: `src/pi-context.ts`, `src/herdr.ts`, `test/context.test.ts`, `README.md`, `docs/configuration.md`, `docs/naming-policy.md`, `ai-artifacts/ARCHITECTURE.md`, `ai-artifacts/SEMANTIC_MAP.md`.

Verification: `bun run check` passed. `bun scripts/test-contained.ts` passed 108 tests, 6 skipped, 0 failed. New context tests cover path sandbox, id lookup, duplicate skip, both JSONL shapes, noise filtering, and empty fallback.

No GitHub comment on #5 yet.
