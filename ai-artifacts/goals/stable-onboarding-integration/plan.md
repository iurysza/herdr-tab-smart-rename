# Stable onboarding integration

## Approved outcome

On 5 September 2026 the user approved finishing reliability first, then adding straightforward installation and reuse of existing Pi or OpenCode provider access. The user delegates merge and implementation decisions. Keep OpenCode if it works, but do not block delivery indefinitely for it. Provider-visible tool definitions alone are not a blocker. No push or external posting is approved.

## Sources and ownership

- Base: `c745243cd9d7f748191333a209e74bcfb21ddfef`, frozen by the reliability owner in Herdr pane `w5R:p2`.
- New branch: `feat/stable-onboarding` in `~/dev/worktrees/herdr-tab-smart-rename/stable-onboarding`.
- Donor: `~/dev/worktrees/herdr-tab-smart-rename/release-ready-optional-onboarding`, branch `goal/release-ready-optional-onboarding`, dirty base `5e6026c`.
- Earlier donor: `review-pr-2-3a79228`. Both donors stay untouched.
- This session owns integration writes. The neighboring agent owns the live worker and reliability checkout. A fresh reviewer advises without editing.

The old release goal records useful behavior and evidence, not an instruction to overwrite the repaired runtime. Its v0.2.0 publication target is stale. That release already exists without installer assets.

## Implementation slices

1. Preserve the repaired naming service, ownership decisions, target outcomes, short locks, JSON parser, Direct request behavior, Windows support, and release automation. Port model selection and Pi/OpenCode adapters behind the existing `Namer` interface. Keep Direct configuration backward-compatible.
2. Port optional setup and private configuration transactions. Keep valid setup by default, stop promptly on cancellation, validate without a completion, and show keybinding guidance without changing Herdr configuration. Merge readiness and resource closure into the repaired CLI and worker rather than replacing them.
3. Port the small shell installer against current Herdr responses. Integrate asset creation with existing release automation. Do not reuse the published v0.2.0 tag or advertise an installer URL that does not exist.
4. Run preserved reliability tests plus source/setup/installer tests. Use fake credentials and local providers. Run server, installer, and cleanup proofs within an OS boundary that cannot write the primary home. Review and fix concrete failures.
5. Present the resulting diff and remaining checks. Keep publication and activation separate from development.

## Validation

- Existing reliability and Direct provider regressions remain passing.
- No model source is loaded before selection. No Pi/OpenCode credential values are copied into Smart Rename.
- Source selection reaches the selected model. Errors do not silently select another provider.
- Setup cancellation and failed validation preserve configuration and worker state.
- Setup uses current Herdr action-log response shapes and reports actual worker readiness.
- No automated check uses the production worker, plugin registry, user config, or credentials.
- One reviewed integration branch contains the work. Old donors and the active checkout stay unchanged.

## Unresolved questions

None. The user subsequently approved end-to-end merge, publication of a tagged release, and local activation on 5 September 2026. Use release-please to generate the version and tag. Bypass the dirty agents repo. Preserve its changes and all unrelated plugin checkout changes. The earlier no-push and no-activation constraints above are superseded for this release.
