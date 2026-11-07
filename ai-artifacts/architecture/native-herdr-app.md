# Native herdr app

The native backend connects Smart Rename to `herdr-app` and `hc`. It does not use the older `herdr` daemon or Sheprd. The native app and Sheprd can both be installed as `Herdr.app`, so executable identity matters more than the bundle filename.

## Naming flow

`src/herdr-app-cli.ts` requires an explicit local native tab ID. It never falls back to inherited daemon IDs or whichever tab the user has focused. The client in `src/herdr-app.ts` combines the app's topology and focus with a read-only `doc.get` RPC through `hc connect`.

The app's public tab list reports a number for an unnamed tab but omits its `named` flag. The versioned core document provides the raw name. An empty raw name means unnamed. A nonempty raw name is explicit, even when it is numeric. If the app's topology and core document disagree, lookup fails without writing anything.

Only the selected tab's terminals supply context. Foreground process facts come from `hc get`. The focused terminal contributes its last 12 screen lines, bounded and sanitized using the existing context policy. Sibling terminals contribute process facts without screen reads. Native naming does not read daemon transcript references or change terminal titles.

`AutoNameService` keeps the existing model sources, context rules, ownership records, retry limits and stale-result checks. Native composition permits only tab targets and disables waiting for unavailable daemon transcript context. The client writes with explicit-ID `herdr-app do tab.rename` arguments. It rejects pane, space, remote and unrelated-tab writes.

## State and manual names

Default state lives below `$XDG_STATE_HOME/herdr-tab-smart-rename/native`, or `~/.local/state/herdr-tab-smart-rename/native`. The directory key includes the app home, core session and selected tab ID. It does not reuse the daemon plugin's state directory. `--state-dir` can select another private directory for this target. Do not share an override between unrelated targets.

`once` and `watch` preserve explicit manual names. An explicitly cleared native name releases manual ownership. `rename-now` deliberately reclaims only its selected tab. `dry-run` previews eligible changes without persisting state or writing names.

A native terminal's identity includes its address, creation time, Pi session label and foreground command. Results from closed tabs, replaced programs or changed sessions are discarded. Manual edits observed after inference win over late results.

The native rename API has no conditional-write argument. An edit between the final snapshot and rename command can still race, as with the daemon backend. The adapter does not bypass that limitation by rewriting the native layout document.

## Foreground watcher

`watch` owns one lock in the selected target's private state directory. A second watcher using the same state directory fails instead of becoming another writer. The process reports readiness after receiving a complete core snapshot.

Core events trigger a debounced reevaluation of that tab. A 60-second sweep covers quiet command context and missed changes, matching the existing daemon worker cadence. The naming service still applies rate and retry rules. Closing the tab stops the watcher with an explicit unavailable-target error. Ctrl+C or SIGTERM closes its event subscription, releases its lock and leaves the app and core running.

The watcher is a foreground command, not an installed login service. There is no global rollout, auto-registration or native layout change. Remote native spaces are not supported by this first backend.

## Verification

`test/herdr-app.test.ts` covers routing, explicit names including numeric names, stale inference, focused-agent selection in split tabs, bounded context, unavailable runtimes, provider errors, dry runs, event reevaluation, duplicate watcher ownership and cancellation. Its command runner is injected, so contained tests cannot reach the real app.

The opt-in `test/herdr-app-live.test.ts` runs the real native CLI with a localhost fake provider. It checks a visible rename, manual numeric protection, a manual edit during inference, invalid provider output, unchanged neighbouring names, restored focus and completed scratch-terminal shutdown. It captures actual app frames with `herdr-app shot`.

A local fixture proves the integration path without testing a real provider account. The phase 2 screenshots and sanitized command results live in `ai-artifacts/herdr-app/`. The designed web report is generated from the report spec there. No native app deployment, external provider request or service installation is implied by these checks.
