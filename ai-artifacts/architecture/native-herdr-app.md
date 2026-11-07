# Native herdr app

The native backend connects Smart Rename to `herdr-app` and `hc`. It does not use the older `herdr` daemon or Sheprd. The native app and Sheprd can both be installed as `Herdr.app`, so executable identity matters more than the bundle filename.

## Target and machine routing

`src/herdr-app-cli.ts` requires an explicit native tab ID. Local targets use a bare ID such as `tb…`. Remote targets use the full app ID, such as `workstation/tb…`. The CLI never falls back to inherited daemon IDs or the focused tab.

`HerdrAppClient` combines app topology and focus with a read-only `doc.get` RPC through `hc connect`. For a remote target, the request includes `params.on` with the machine name. Each machine owns its own `herdr-app` layout document. Smart Rename never calls `doc.set`.

App IDs and core terminal addresses retain their machine prefix. Raw layout IDs and terminal ownership labels are bare. The client removes only the verified machine prefix for those comparisons. It rejects placements that belong to another machine.

The public app list displays a number for an unnamed tab and omits its `named` flag. The core document provides the raw name. An empty name means unnamed. Every nonempty name is explicit, including a numeric name. A remote app/document mismatch is temporarily unavailable, not a closed tab.

## Context and naming

Only the selected tab's terminals supply context. `hc get` provides foreground process facts. The chosen terminal contributes its last 12 screen lines, bounded and sanitized with the existing policy. Sibling terminals contribute process facts without screen reads.

Remote context uses qualified terminal addresses through the local core broker. Remote folders are never passed to local Git. Native context does not resolve daemon transcript references, load local transcripts for remote paths or change terminal titles.

The naming process and provider configuration remain local. Remote terminal context reaches the provider selected here, not an account configured on the remote machine. `AutoNameService` keeps the existing context rules, ownership records, retry limits and stale-result checks. Native composition permits only the selected tab target.

## State and core identity

Default state lives below `$XDG_STATE_HOME/herdr-tab-smart-rename/native`, or `~/.local/state/herdr-tab-smart-rename/native`. The base directory key includes app home, local core session and selected tab ID. Local targets keep that directory unchanged.

For remote targets, `createNativeService` resolves the machine's permanent core ID and remote session before choosing state paths. State and locks live in `<base>/remote/<hash>`. The hash also includes app home, local core session and the full tab ID. An explicit `--state-dir` is a base directory for remote targets. Do not share a local override between unrelated local targets.

`createNativeService` is asynchronous and returns `{ service, target, stateDir }`. Both one-shot and watcher composition use the resolved directory. Direct callers must await composition and use its returned service.

A known paired machine can bind while offline. Every usable snapshot verifies that the alias still points to the bound core and session. A replacement core stops the service rather than inheriting ownership. Restarting resolves a separate namespace. Terminal identity hashes also include creation time, Pi session and foreground arguments; raw command arguments are not stored as identity.

`once` and `watch` preserve manual names. Clearing a native name releases manual ownership. `rename-now` deliberately reclaims only its selected tab. `dry-run` previews eligible changes without persisting state or names.

## Write confirmation

The client writes with explicit-ID `herdr-app do tab.rename`. The app can acknowledge before the owning core persists the name, so the client confirms the raw name on the bound core. It sends one write, never a blind retry. A different name during confirmation wins over the pending suggestion.

Confirmation uses the existing 10-second command tripwire. A late write after that deadline can appear manual on the next run because failure restores prior ownership. This favours preserving names over reclaiming uncertain writes.

The API has no conditional rename. A manual edit or alias change between the last verification and the app command can still race. The adapter does not rewrite the whole layout to work around that limit.

## Foreground watcher

`watch` owns a lock beside its resolved state. A second watcher for the same namespace fails. Readiness follows the initial core snapshot.

The existing unfiltered `hc events --json` subscription carries local and remote changes. Remote document notifications include `params.machine`. A terminal filter omits document events, so the watcher does not use one. Events trigger debounced reevaluation; a 60-second sweep covers quiet context and missed changes.

A reported remote outage preserves state and keeps the broker subscription alive. This includes a confirmed disconnect between snapshot verification and terminal lookup. Unknown machines, unsupported core versions and changed core identities are explicit failures. A broken local broker event stream remains fatal; the CLI is not a service supervisor.

Closing the target stops its watcher. Ctrl+C or SIGTERM closes the subscription and releases the lock. No login service, global rollout, native layout change or remote agent installation is part of this backend.

## Verification

`test/herdr-app.test.ts` mocks command boundaries. It covers machine routing, raw-name ownership, identity replacement, transient outages, write confirmation, state isolation, bounded context, local Git exclusion and watcher lifecycle.

`test/herdr-app-live.test.ts` is opt-in. Local mode checks the real CLI with a localhost fake provider. Remote mode additionally selects an already-connected machine and proves a watcher rename after real remote events. Both modes preserve other names, restore selection and wait for scratch-terminal shutdown.

The local-only phase 2 receipts remain in `ai-artifacts/herdr-app/`. Current remote receipts and verification live in `ai-artifacts/herdr-app/remote/`. Real provider accounts and deliberate shared-connection outages are outside these tests.
