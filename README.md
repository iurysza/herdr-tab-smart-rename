<p align="center">
  <img src="assets/herdr-tab-smart-rename-banner.png" width="720" alt="Magic wand naming a Herdr tab">
</p>

<h1 align="center">herdr-tab-smart-rename</h1>

<p align="center"><strong>Herdr tabs that say what the work is.</strong></p>

Smart Rename turns default workspace and tab numbers into short task labels while leaving user-chosen names alone.

```text
3  ->  Repair Tab Ownership
4  ->  Run Tests
5  ->  Dev Server
```

Obvious processes use deterministic names. Ambiguous work can use Kimi Code by default or any OpenAI-compatible endpoint.

## Install

Requires Herdr 0.7.0+ and Bun 1.1.34+.

```sh
herdr plugin install iurysza/herdr-tab-smart-rename
herdr plugin action invoke configure-ai --plugin autoname
herdr plugin action invoke check-ai --plugin autoname
herdr plugin action invoke start --plugin autoname
```

`configure-ai` opens Herdr's private `provider.env`. For Kimi Code, add:

```dotenv
SMART_RENAME_API_KEY=...
```

No standalone key means deterministic naming still works, but model-backed renames do not.

For a local checkout, install dependencies before linking; Herdr does not run build commands for local links.

```sh
bun install
herdr plugin link "$PWD"
herdr plugin action invoke start --plugin autoname
```

The plugin starts one detached worker only when asked. It does not install a launchd service.

## Keybindings and actions

Suggested Herdr bindings:

```toml
[[keys.command]]
key = "prefix+t"
type = "plugin_action"
command = "autoname.rename-now"
description = "smart rename current tab"

[[keys.command]]
key = "prefix+alt+t"
type = "plugin_action"
command = "autoname.rename-all"
description = "force smart rename all tabs"
```

| Action | Behavior |
| --- | --- |
| `start` / `stop` / `status` | Control or inspect the singleton worker. |
| `configure-ai` | Edit private provider configuration in an overlay. |
| `check-ai` | Validate provider settings without making a request. |
| `rename-now` | Reclaim and rename the current tab immediately. |
| `rename-all` | Reclaim and rename every tab sequentially. |
| `reset-tab` | Return the current tab to automatic ownership and evaluate it. |
| `reset-workspace` | Return the current workspace to automatic ownership and evaluate it. |

Invoke any action with `herdr plugin action invoke <action> --plugin autoname`.
Explicit rename actions show start/result toasts, bypass model cooldown, and reclaim manual tabs as user-approved overrides.

## Naming and ownership

Smart Rename selects one dominant pane:

1. Focused detected agent.
2. Any working or blocked detected agent.
3. Focused ordinary command.
4. First pane.

Recognized tests, dev servers, log followers, and remote shells become `Run Tests`, `Dev Server`, `View Logs`, and `Remote Shell`. Agent tasks and unclear commands may use the model. Weak command context must remain stable across two observations before a request.

Labels use 2–4 Title Case words and at most 30 characters. Workspaces describe the project; tabs describe the task. Manual names always win until reset or an explicit rename action. Ownership survives worker restarts.

See [`docs/naming-policy.md`](docs/naming-policy.md) for the full behavior contract.

## Provider and privacy

Kimi Code defaults:

```dotenv
SMART_RENAME_PROVIDER=kimi-code
SMART_RENAME_BASE_URL=https://api.kimi.com/coding/v1
SMART_RENAME_MODEL=kimi-for-coding
SMART_RENAME_REASONING_EFFORT=medium
SMART_RENAME_TIMEOUT_MS=45000
```

Set those values plus `SMART_RENAME_API_KEY` to use another OpenAI-compatible endpoint. `KIMI_API_KEY` is also accepted. `SMART_RENAME_REASONING_EFFORT` accepts `low`, `medium`, or `high`; Kimi defaults to `medium`, while other providers leave it unset unless configured. Kimi requests use its documented 32,768 output-token capability so reasoning cannot truncate the final JSON label. Process-level `SMART_RENAME_*` values override `provider.env`; the file reloads before every request.

Herdr keeps the config directory and file at `0700` and `0600`. Keys are never written to plugin state or logs. Model context is sanitized and capped at 4,500 serialized characters.

Pi is optional context collection only: for detected Pi panes, Smart Rename reads bounded user-request samples from the local session file. It never launches Pi or uses Pi authentication. Sibling panes contribute process summaries, not conversation content.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun test
bun pm pack --dry-run
```

The code follows the product flow: `domain.ts` owns pure naming policy, `text.ts` sanitizes input, `herdr.ts` and `pi-context.ts` collect context, `provider.ts` names ambiguous work, `storage.ts` preserves ownership safely, and `service.ts` orchestrates the path. `cli.ts`, `configure.ts`, and `worker.ts` are thin entrypoints.

Preview the current tab without renaming or changing ownership:

```sh
bun src/cli.ts dry-run
```

A dry run may call the configured model and respects existing manual locks when plugin state is available.

Runtime state and logs live under `~/.local/state/herdr/plugins/autoname/`. The worker reconnects after socket closure, serializes cross-process state updates, preserves expected labels before rename writes, and sweeps every 60 seconds for task changes without lifecycle events.

## Troubleshooting

- Worker stopped: `herdr plugin action invoke start --plugin autoname`
- AI config missing: run `configure-ai`, then `check-ai`.
- Manual label never changes: use `reset-tab` or an explicit rename action.
- Unexpected label: run `bun src/cli.ts dry-run` and check the [naming policy](docs/naming-policy.md).
- Worker logs: `herdr plugin log list --plugin autoname --limit 10`

Current limits: automatic socket discovery covers the local Herdr session only; closed ownership records and worker logs are not pruned.
