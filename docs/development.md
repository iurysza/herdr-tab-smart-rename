# Development

Smart Rename runs TypeScript directly with Bun. There is no JavaScript build step.

## Prepare a checkout

```sh
bun install --frozen-lockfile
bun run check
```

Use Bun 1.2.23 or newer. `bun run check` runs strict TypeScript checks without emitting files.

To use the checkout in Herdr, link it after installing dependencies:

```sh
herdr plugin link "$PWD"
herdr plugin action invoke setup --plugin tab-smart-rename
```

Use an isolated Herdr session if the released plugin is already registered. Do not run a second worker against the same session or replace a running worker's code.

## Run tests safely

On macOS, use the contained runner:

```sh
bun scripts/test-contained.ts
```

It supplies a temporary home and fake credentials. It blocks source writes, unrelated home access, and external network access. Test evidence stays in the printed temporary directory.

To check real Pi and OpenCode integrations against a local fake provider:

```sh
bun scripts/test-contained.ts --harness test/harness-runtime.test.ts
```

This uses the installed OpenCode executable at `~/.opencode/bin/opencode` and the package's Pi runtime. It also checks that OpenCode cannot execute a requested tool.

To check the lockfile without installing or running package scripts:

```sh
bun scripts/test-contained.ts --lock-check
```

On disposable CI machines or an isolated development environment:

```sh
bun test
```

CI covers Linux with the minimum and latest Bun versions, plus Windows with latest Bun. Platform-specific tests skip where unsupported. Do not use real credentials for automated tests or derive cleanup targets from your real home directory.

## Live Herdr checks

Use a disposable home and an isolated Herdr session. These tests create and close fixture tabs, so do not run them against unrelated work.

```sh
SMART_RENAME_LIVE_TEST=1 bun test test/herdr-live.test.ts
```

The tests use a local fake provider, not a billed model. They cover pane closure during inference, manual-label protection, target scope, and failure cleanup. The default contained runner intentionally cannot reach a real Herdr socket.

## Live native-app checks

The native app is a separate runtime. Do not link the daemon plugin to test it. With the native app open, run:

```sh
SMART_RENAME_NATIVE_LIVE_TEST=1 bun test test/herdr-app-live.test.ts
```

This opt-in test creates and closes one `Tab Rename Scratch` tab in the selected native space. It uses a localhost fake provider, exercises the actual native CLI, rejects a late model result after a manual edit, preserves a numeric manual name and checks failure cleanup. It also verifies that other tab names and the original selection stay unchanged. No real provider credentials or daemon writes are used.

Set `SMART_RENAME_NATIVE_EVIDENCE_DIR` to retain screenshots and command results in a chosen directory. The test waits for core terminal shutdown after closing the tab. Finished core records remain intact.

For the remote scenario, set `MACHINE` to an already-connected, non-temporary core profile with an existing native-app space. The test uses a POSIX scratch shell in `/tmp` and `/bin/cat`. It does not establish, replace or disconnect a remote connection.

```sh
SMART_RENAME_NATIVE_REMOTE_LIVE_TEST=1 \
SMART_RENAME_NATIVE_REMOTE_MACHINE="$MACHINE" \
bun test test/herdr-app-live.test.ts
```

Remote mode creates one owned tab, runs the same CLI safeguards and verifies a real watcher rename. Scratch-only metadata changes supply the two stable observations required by the naming policy. Provider fixtures run here on localhost. Existing tabs and agents stay untouched; the original space, tab and pane selection return after cleanup.

Mocked tests cover disconnect and core-replacement races. Do not interrupt a shared remote connection to test them.

Run the mocked native client and watcher tests without touching a live app:

```sh
bun scripts/test-contained.ts test/herdr-app.test.ts
```

The full contained suite includes them. Live tests remain skipped unless explicitly enabled.

## Before committing

```sh
bun run check
bun run lint
bun scripts/scan-secrets.ts
git diff --check
```

Run the relevant contained tests too. For documentation changes, check local links, image paths, shell examples, and any commands against the current CLI help.

## Find your way around

- [Code map](../ai-artifacts/SEMANTIC_MAP.md): which file owns a behavior
- [Architecture](../ai-artifacts/ARCHITECTURE.md): naming, setup, and worker flows
- [Release process](releasing.md): versioning and installer publication

`docs/naming-policy.md` is also the runtime's default model prompt. Editing it changes naming behavior, not just documentation.
