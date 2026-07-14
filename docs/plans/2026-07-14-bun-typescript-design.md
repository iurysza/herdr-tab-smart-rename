# Bun TypeScript rewrite

## Goal

Run Smart Rename directly with Bun and strict TypeScript while preserving every naming, ownership, provider, state, action, and worker behavior.

## Runtime

- Bun executes `src/*.ts` directly.
- `bun:test` replaces `node:test`.
- `tsc --noEmit` provides strict static checks; no JavaScript build output.
- Herdr installs production dependencies with Bun and invokes Bun entrypoints.

## Boundaries

- `domain.ts`: state and naming types plus pure ownership, naming, context, and churn rules.
- `text.ts`: dependency-backed ANSI stripping and secret detection plus app-specific path/control normalization.
- `herdr.ts`: Herdr commands, validated snapshots/process data, pane context, and event framing.
- `pi-context.ts`: bounded optional Pi session sampling.
- `provider.ts`: bounded dotenv parsing, validated provider/model data, and the AI SDK namer.
- `storage.ts`: validated state/PID persistence, atomic writes, locks, and singleton verification.
- `service.ts`: orchestration and the single composition function.
- `cli.ts`, `worker.ts`, `configure.ts`: thin entrypoints.

## Dependencies

- `dotenv` parses `provider.env`.
- `strip-ansi` removes terminal escapes.
- `secret-sniff` detects known credentials and accepts narrow custom patterns for assignment/header forms.
- `zod` validates untrusted JSON and environment-derived configuration.

## Guardrails

State schema v1, paths, permissions, locks, stale-writer protection, action/pane/plugin IDs, notifications, provider defaults, per-call reload, model limits, event subscriptions, sweep timing, and keybindings stay unchanged. Pi remains optional context only. No live model request runs without an existing standalone key.
