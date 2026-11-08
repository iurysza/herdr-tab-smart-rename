# Native herdr app

The native backend connects Smart Rename to `herdr-app` and `hc`. It supports explicit foreground commands and an optional macOS login service. Neither path uses the older `herdr` daemon or Sheprd. The native app and Sheprd can both be installed as `Herdr.app`, so executable identity matters more than the bundle filename.

[Knowledge base](../README.md) · [Naming glossary](../CONTEXT.md) · [Installation commands](../../docs/install.md#native-macos-app)

## Target and machine routing

`src/herdr-app-cli.ts` requires an explicit native tab ID. Local targets use a bare ID such as `tb…`. Remote targets use the full app ID, such as `workstation/tb…`. The CLI never falls back to inherited daemon IDs or the focused tab.

`HerdrAppClient` combines app topology and focus with a read-only `doc.get` RPC through `hc connect`. For a remote target, the request includes `params.on` with the machine name. Each machine owns its own `herdr-app` layout document. Smart Rename never calls `doc.set`.

App IDs and core terminal addresses retain their machine prefix. Raw layout IDs and terminal ownership labels are bare. The client removes only the verified machine prefix for those comparisons. It rejects placements that belong to another machine.

The public app list displays a number for an unnamed tab and omits its `named` flag. The core document provides the raw name. An empty name means unnamed. Every nonempty name is explicit, including a numeric name. A local or remote app/document mismatch is temporarily unavailable, not a closed tab.

## Context and naming

Only the selected tab's terminals supply context. `hc get` provides foreground process facts. The chosen terminal contributes its last 12 screen lines, bounded and sanitized with the existing policy. Sibling terminals contribute process facts without screen reads.

Remote context uses qualified terminal addresses through the local core broker. Remote folders are never passed to local Git. Native context does not resolve daemon transcript references, load local transcripts for remote paths or change terminal titles.

The naming process and provider configuration remain local. Remote terminal context reaches the provider selected here, not an account configured on the remote machine. `AutoNameService` keeps the existing context rules, ownership records, retry limits and stale-result checks. Each native service instance permits only its bound tab target.

## State and core identity

Default state lives below `$XDG_STATE_HOME/herdr-tab-smart-rename/native`, or `~/.local/state/herdr-tab-smart-rename/native`. The base directory key includes app home, local core session and selected tab ID. Local targets keep that directory unchanged.

For remote targets, `createNativeService` resolves the machine's permanent core ID and remote session before choosing state paths. State and locks live in `<base>/remote/<hash>`. The hash also includes app home, local core session and the full tab ID. An explicit `--state-dir` is a base directory for remote targets. Do not share a local override between unrelated local targets.

`createNativeService` is asynchronous and returns `{ service, target, stateDir }`. Both one-shot and watcher composition use the resolved directory. Direct callers must await composition and use its returned service.

A known paired machine can bind while offline. Every usable snapshot verifies that the alias still points to the bound core and session. A replacement core blocks the bound service rather than inheriting ownership. The installed supervisor continues managing unrelated targets. Restarting resolves a separate namespace. Terminal identity hashes also include creation time, Pi session and foreground arguments; raw command arguments are not stored as identity.

`once` and `watch` preserve manual names. Clearing a native name releases manual ownership. `rename-now` deliberately reclaims only its selected tab. `dry-run` previews eligible changes without persisting state or names.

## Write confirmation

The service passes the raw tab name from its final ownership snapshot into the native rename adapter. The adapter compares its fresh document read with that exact name, including an empty cleared name rather than its displayed tab number. A changed name or missing tab produces a typed skipped result without issuing a write. The service restores prior ownership, releases the model attempt, and leaves reconciliation to protect the newer manual name on the next evaluation.

If the name still matches, the client writes with explicit-ID `herdr-app do tab.rename`. The app can acknowledge before the owning core persists the name, so the client confirms the raw name on the bound core. It sends one write, never a blind retry. A different name during confirmation wins over the pending suggestion. Local and remote final-read races, numeric manual names, closure, and existing confirmation checks are covered in [native tests](../../test/herdr-app.test.ts).

Confirmation uses the existing 10-second command tripwire. A late write after that deadline can appear manual on the next run because failure restores prior ownership. This favours preserving names over reclaiming uncertain writes.

The command inventory exposes only `id` and `name` for `tab.rename`, with no conditional rename. A manual edit or alias change after the final read and verification but before the app command can still race. The adapter does not rewrite the whole layout to work around that limit.

## Foreground watcher

`watch` owns a lock beside its resolved state. A second watcher for the same namespace fails. Readiness follows the initial core snapshot.

The existing unfiltered `hc events --json` subscription carries local and remote changes. Remote document notifications include `params.machine`. A terminal filter omits document events, so the watcher does not use one. Events trigger debounced reevaluation; a 60-second sweep covers quiet context and missed changes.

A reported remote outage preserves state and keeps the broker subscription alive. This includes a confirmed disconnect between snapshot verification and terminal lookup. Unknown machines, unsupported core versions and changed core identities are explicit failures. A broken local broker event stream remains fatal; the CLI is not a service supervisor.

Closing the target stops its foreground watcher. Ctrl+C or SIGTERM closes the subscription and releases the lock. Foreground commands do not install the optional login service described below. Neither path changes native layouts or installs an agent on remote machines.

## One installed supervisor for all tabs

[native-worker.ts](../../src/native-worker.ts) owns one unfiltered event subscription and discovers existing and new eligible local and remote tabs. Events debounce reevaluation for 400ms. A 60-second sweep recovers missed or quiet changes. The scheduler reuses `MAX_CONCURRENT_TABS`, currently 3, with one evaluation per tab and a coalesced follow-up for events during work.

Each target uses `nativeOptions` state derivation and `createNativeService`, matching explicit once/watch ownership namespaces. The supervisor holds the target's `watch.lock`, so a foreground watcher cannot become a second background writer. Per-target services borrow the shared namer without its close method. Retiring a tab releases its lock, not the source used by surviving tabs. Only the supervisor closes the source after work drains.

Successful snapshots must show the tab absent from both app topology and its core document before retirement. App/core downtime, failed discovery, and surviving documents preserve target state. Replaced remote cores stay blocked for that retained target lifetime, including after watch-lock contention. Other tabs continue.

The separate runtime directory holds `supervisor.lock` and private `status.json`, not shared naming state. Health version 1 includes PID, state, managed-tab count, timestamp, and `targets: { active, waiting, blocked }`. Optional `lastError` records a target ID, safe short reason, and timestamp. Runtime error classification retains useful categories and HTTP status codes without copying response bodies or terminal context.

`ready` means the event transport is connected and app discovery succeeded. It does not require every target or provider request to succeed. Offline or blocked targets remain visible in target counts. The latest error remains historical across later skipped evaluations. Status combines health with the actual registered service PID, rather than treating stale JSON as a running worker.

Evidence: [supervisor tests](../../test/native-worker.test.ts), [native service tests](../../test/native-install.test.ts), and [native composition](../../src/herdr-app.ts).

## Verified payload and user service

[install.sh](../../installer/install.sh) selects native installation only with `--native`; the daemon route remains the default. A rendered release installer binds the archive checksum to its exact tag and commit. The local-checkout command builds and renders that same bound snapshot before invoking it. Source packaging and the embedded verifier live in [package-native.ts](../../scripts/package-native.ts).

The verifier checks archive SHA-256 against both the installer and release manifest. It validates release identity and source hashes before writing files. Only regular-file USTAR entries are accepted. Absolute paths, traversal, duplicates, links, special headers, and unexpected permissions are rejected. User configuration, credentials, tests, and node_modules are excluded from the archive.

Production dependencies install in a private staging directory with a frozen lockfile and install scripts disabled. The complete directory is verified again, then atomically published as `versions/<commit>`. Existing versions must match the bound source inventory and dependency receipt. Modified or unowned files cause refusal, not replacement. [Packaging tests](../../test/native-package.test.ts) and [bootstrap tests](../../test/installer.test.ts) cover these checks.

[native-install.ts](../../src/native-install.ts) owns activation metadata, the current pointer, the installed command wrapper, and one LaunchAgent. [native-service.ts](../../src/native-service.ts) renders RunAtLoad and KeepAlive with absolute runner/worker arguments and a non-secret environment whitelist. The LaunchAgent does not carry provider keys. Native source installation never invokes daemon status, plugin installation, or config-directory commands.

A missing or invalid native configuration first imports only the conventional daemon directory's selection, naming prompt, and provider file. Source files stay unchanged. Valid native or imported settings skip the wizard. `runNativeSetup` otherwise reuses model prompts and validation without daemon keybinding or startup hooks. The outer installer transaction includes imported prompt bytes and restores private configuration before restarting a previous service on activation failure.

After activation, [native-trigger.ts](../../src/native-trigger.ts) installs the in-app trigger: a headless herdr-app mod at `$HERDR_APP_HOME/mods/smart-rename` whose `init` runs `herdr-app-cli.ts rename-now` for the focused tab through the `current` payload with the activation's environment, toasts, and closes its own 1×1 overlay. The key `ctrl-shift-r` → `mod.open:smart-rename` goes into the `global` section of `keys.json` only when that key is unbound; a backup copy is written first. The mod is owned by a marker comment in `main.js`; a foreign mod of that name or a person's own binding of the key is reported, never replaced. Uninstall removes the owned mod and that one binding. The trigger is best-effort and runs after the service is ready, so it cannot fail an activation.

Installation requires fresh ready health matching the registered PID within the named readiness bound. Status and uninstall need no running app, source credentials, or provider availability. Uninstall removes only owned activation artifacts and leaves private configuration, naming state, and versioned source. [Service tests](../../test/native-install.test.ts) cover ownership checks, rollback, cancellation, config import, and PID matching.

## Packaged integration verification

[scripts/verify-native-e2e.ts](../../scripts/verify-native-e2e.ts) is a separate opt-in macOS check:

```sh
bun scripts/verify-native-e2e.ts /tmp/smart-rename-native-e2e
```

It copies the real source into an isolated checkout and runs `sh installer/install.sh --native` with a disposable HOME. Real frozen production dependency installation runs in a separate sandboxed actor. That actor can reach only a local CONNECT tunnel whose sole accepted destination is `registry.npmjs.org:443`. All service, worker, status, and uninstall actors deny network and cannot execute real launchctl or read the real HOME.

A Bun command shim injects fake launchctl and model-source ports through the installed modules' public entry functions. The installed wrapper and runner stay unchanged. The real worker reads one synthetic tab through fake app/core executables, applies a fake-source suggestion, publishes ready health, and shuts down during native uninstall. The check verifies configuration retention and removal of owned service artifacts.

The worker host separately resolves and imports both Pi SDK packages from the installed node_modules tree. It checks the exports used by the adapter without creating a Pi runtime or making a provider call. This proves packaged dependency loading, not provider authentication or completion success. [Harness policy tests](../../test/native-e2e.test.ts) run without registry access in the normal contained suite.

## Verification

`test/herdr-app.test.ts` mocks command boundaries. It covers machine routing, raw-name ownership, identity replacement, transient outages, write confirmation, state isolation, bounded context, local Git exclusion and watcher lifecycle.

`test/herdr-app-live.test.ts` is opt-in. Local mode checks the real CLI with a localhost fake provider. Remote mode additionally selects an already-connected machine and proves a watcher rename after real remote events. Both modes preserve other names, restore selection and wait for scratch-terminal shutdown.

The local-only phase 2 receipts remain in `ai-artifacts/herdr-app/`. Current remote receipts and verification live in `ai-artifacts/herdr-app/remote/`. Real provider accounts and deliberate shared-connection outages are outside these tests.
