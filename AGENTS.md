# AGENTS.md

Herdr plugin that autorenames tabs with short, context-aware names.

## Map

1. Research in `ai-artifacts/`: `ARCHITECTURE.md`, `SEMANTIC_MAP.md`, `goals/`, `plans/`.
2. Change the code.
3. Typecheck: `bun run check`.
4. Lint: `bun run lint`.
5. Test: `bun test`.

Start in `ai-artifacts/` for how the project works. Update those files when architecture or behavior changes.

## Commands

Bun (`packageManager bun@1.2.23`).

```sh
bun install
bun run check      # tsc --noEmit
bun run lint       # oxlint
bun run lint:fix   # oxlint --fix
bun test
bun run setup      # bun src/setup.ts
```

Gate before push:

```sh
bun run check && bun run lint && bun test
```

CI workflows live in `.github/workflows/`. Run the local gate before you push.

## Git commits

Never include Cursor (or any Cursor agent/bot) as git author, committer, or in a Co-authored-by / similar trailer.
