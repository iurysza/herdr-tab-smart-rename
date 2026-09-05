# Stable onboarding integration

## 5 September 2026

Layered optional setup onto reliability commit `c745243`. Kept the repaired naming service, independent pane ownership, stale-result rejection, Direct transport, and Windows runtime path. The two donor worktrees remain intact.

`ModelSourceNamer` delegates unchanged Direct installations to `AiSdkNamer`. Pi and OpenCode load only when selected. They retain credential ownership. Selection changes close the old source. OpenCode uses temporary sessions with denied tool execution and closes its own server after completion.

Setup collects choices before writes, preserves valid configuration by default, and rolls back failed configuration validation. Keybinding guidance never changes Herdr configuration. Worker start waits for connection readiness and rejects a worker serving another socket.

Added a release-bound shell installer and an asset workflow alongside release-please. Direct configuration round-trip tests caught and fixed dotenv escaping and the wizard's None reasoning option.

## Verification before publication

Evidence directory on the development Mac: `/tmp/smart-rename-release.7E6KGQ`.

- Strict TypeScript check passed.
- `bun scripts/test-contained.ts`: 104 passed, 6 opt-in skips. Includes repaired naming behavior, source routing, setup cancellation, private configuration rollback, installer behavior, and real isolated worker readiness.
- `bun scripts/test-contained.ts --harness test/harness-runtime.test.ts`: 3 passed. Real Pi and OpenCode completed through an unbilled local provider with disposable credentials. A model-requested OpenCode tool did not create the sandbox-local sentinel, and the subsequent naming completion succeeded.
- Frozen-lockfile dry run passed without changing dependencies.
- Secret-pattern check and `git diff --check` passed. The scanner excludes only the existing synthetic basic-auth URL fixture.
- Workflow YAML parsing passed.

Tests run inside a macOS sandbox that denies external network access, unrelated home reads, and writes outside the retained test directory. The current worker and real credentials were not used by automated checks. Native Windows and Linux validation is delegated to GitHub CI. Earlier real Herdr reliability tests are recorded with the base commit.

## Approved publication and activation

The user approved committing, merging, publishing a new tagged release, and installing that release on this Mac. Use release-please for the version, changelog, tag, and GitHub Release. Verify CI and installer assets before local activation. Do not merge unrelated contributor pull requests.

Install directly through Herdr. Do not run the agents installer or change the dirty agents repo, dotfiles, shell configuration, credential selection, or user keybindings. The change replaces only the Smart Rename installation and its worker. Existing private Direct settings remain selected. Dependency size measured in the donor installation was 213 MB.

The previous worker used the canonical checkout at `c745243`. Before switching roots, stop that worker through its registered action. Preserve the canonical checkout's three dirty handoff documents and `.sem/`.

Rollback uses the clean `rename-reliability` worktree at `c745243`: install its frozen production dependencies if needed, link it through Herdr, and start its worker. Do not reset or clean the canonical checkout to roll back. Preserve private configuration in either direction.

## Remaining checks at this checkpoint

Publish through the normal release workflow, verify the actual tag and downloaded checksums, install that exact release, and verify the live worker. Record the final release and activation evidence separately after those operations succeed.
