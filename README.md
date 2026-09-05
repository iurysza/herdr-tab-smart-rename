<p align="center">
  <img src="assets/herdr-tab-smart-rename-banner.png" width="720" alt="Pixel wand renaming a terminal tab">
</p>

<h1 align="center">herdr-tab-smart-rename</h1>

<p align="center"><strong>Tabs that say what the work is.</strong></p>

Smart Rename turns numbered Herdr tabs into short task labels. Known processes get instant names such as `Run Tests`, `Dev Server`, and `View Logs`; ambiguous work uses your selected Pi, OpenCode, or Direct model. Manual names always win.

## Demo

https://github.com/user-attachments/assets/c9d12c33-e458-4a29-986c-c403d64aff02

## Install and optional setup

Requires Herdr 0.7.0+ and Bun 1.1.34+. Existing Direct configurations keep working without setup. Deterministic names work without a model.

Install the plugin, then run setup if you want to choose a model:

```sh
herdr plugin install iurysza/herdr-tab-smart-rename
herdr plugin action invoke setup --plugin tab-smart-rename
```

For a local checkout, run `bun install --frozen-lockfile`, then `herdr plugin link "$PWD"`.

Setup keeps valid configuration by default. Choose Pi or OpenCode to reuse a connected provider and model, or Direct to enter an OpenAI-compatible API key. It validates without a model completion, shows optional keybinding instructions, then starts the worker for the current Herdr session.

Cancelling leaves configuration and worker state unchanged. Failed saves or validation restore the previous configuration. A worker-start failure keeps validated configuration and prints a retry command. Setup never edits or reloads your Herdr configuration.

For macOS and Linux, each release includes a tag-bound `install.sh` and `SHA256SUMS`. Download both from the [release page](https://github.com/iurysza/herdr-tab-smart-rename/releases/latest), inspect the script, then run:

```sh
shasum -a 256 -c SHA256SUMS
sh install.sh
```

Use `sh install.sh --install-only --yes` to install without interactive setup.

### Windows

Herdr's Windows preview is supported with Bun available on `PATH`. The plugin
uses direct Bun commands instead of a Unix shell launcher, and inspects worker
processes through PowerShell.

## Keybindings

```toml
[[keys.command]]
key = "prefix+t"
type = "plugin_action"
command = "tab-smart-rename.rename-now"
description = "smart rename current tab"

[[keys.command]]
key = "prefix+alt+t"
type = "plugin_action"
command = "tab-smart-rename.rename-all"
description = "force smart rename all tabs"
```

Every explicit rename ends with a notification: renamed, not renamed, or failed. During a model-backed current-tab rename, a diamond pulse appears before its label.

## Actions

| Action | Effect |
| --- | --- |
| `rename-now` | Reclaim and rename only the current tab |
| `rename-all` | Reclaim and rename tabs, without changing panes or workspaces |
| `reset-tab` | Return the current tab to automatic naming |
| `reset-pane` | Reclaim and rename only the current agent pane |
| `reset-workspace` | Reclaim and rename only the current workspace |
| `setup` | Choose a source/model, validate, and start the worker |
| `configure-prompt` | Edit naming instructions |
| `check-ai` | Validate source, model, and prompt without a completion |
| `start` / `stop` / `status` | Control the worker |

```sh
herdr plugin action invoke <action> --plugin tab-smart-rename
```

## Naming behavior

Smart Rename uses one dominant pane to name the shared tab workstream: focused agent, another active agent, focused command, then first pane. Supporting servers and logs never replace an active agent's task.

Each recognised agent pane also gets its own label from its individual session and process context. Two agents in the same tab can show different task labels, while the tab keeps one shared workstream title. Manual pane names remain protected until `reset-pane`. A manually named pane can still supply task context for its tab.

Labels use 2–4 Title Case words, stay under 30 characters, and describe the task—not its tool, model, or project. Weak evidence produces no rename. Manual labels remain locked until reset or explicit rename.

Background naming handles each automatic workspace, tab, and agent pane independently. One failed pane request does not block a valid tab name. Explicit actions affect only their named targets.

If a pane closes, moves, or changes agent session during inference, Smart Rename discards names based on that old context. Closing a pane does not cancel an already-sent provider request. Closed-item records are removed when the next snapshot is reconciled.

See the [naming policy](docs/naming-policy.md) for the full contract.

## Model sources

Setup stores only the source, provider, model, and optional thinking level or variant in private `model-selection.json`. The selection reloads before each model-backed rename. A failed source never falls back to another source.

- **Pi** uses Pi's public model runtime and its built-in or `models.json` providers. Pi owns API keys and subscription authentication. Smart Rename does not launch a Pi agent or load its tools and extensions.
- **OpenCode** uses an installed OpenCode executable and its connected providers. It makes each naming request in a temporary session with tool execution denied, then deletes the session and closes its own server. OpenCode can still send tool definitions to the provider.
- **Direct** keeps the existing standalone OpenAI-compatible path and private `provider.env`. Process configuration still overrides the file.

`configure-ai` remains a compatibility alias for `setup`.

### Direct configuration

Provider defaults live in [`provider.env.example`](provider.env.example):

```dotenv
SMART_RENAME_PROVIDER=openai
SMART_RENAME_BASE_URL=https://api.openai.com/v1
SMART_RENAME_MODEL=gpt-5.6-luna
SMART_RENAME_REASONING_EFFORT=medium
SMART_RENAME_TIMEOUT_MS=45000
```

Use `SMART_RENAME_API_KEY` for another OpenAI-compatible provider. `OPENAI_API_KEY` and Kimi's `KIMI_API_KEY` are also supported when their provider is selected. Config reloads before every model request.

### Custom prompt

The default system prompt is [`docs/naming-policy.md`](docs/naming-policy.md). Create a private editable copy with:

```sh
herdr plugin action invoke configure-prompt --plugin tab-smart-rename
```

It opens `~/.config/herdr/plugins/config/tab-smart-rename/naming-prompt.md`. A prompt can be this small:

```md
Name the current persistent task in 2–4 Title Case words.
Omit project, app, agent, and model names.
Return JSON only: {"tab":"Assess Python Migration","reason":"Current task."}
If unclear: {"tab":null,"reason":"no meaningful task"}
```

Set `SMART_RENAME_PROMPT_PATH` to use another file. Prompts reload per request; built-in JSON and label validation still applies.

## Privacy

Tab requests use bounded, sanitized evidence from the dominant pane, with sibling process summaries as supporting context. Pane requests use that pane alone. Pi panes may contribute short user-request excerpts. A manual label protects the label, not its pane content from use as tab context. Smart Rename removes terminal formatting, common secret shapes, and the local home path before sending context.

Direct keys stay in Herdr's private plugin config. Pi and OpenCode retain their own credentials. Smart Rename does not copy harness credentials, and no key enters its naming state or logs.

## Troubleshooting

- Worker stopped: `herdr plugin action invoke start --plugin tab-smart-rename`
- Config invalid: run `setup`.
- Pi or OpenCode provider missing: connect it in that tool, then rerun `setup`.
- Direct authentication fails: check the endpoint and key. `check-ai` validates configuration, not a paid completion.
- Worker belongs to another Herdr socket: stop it in the owning session before starting it here. Setup never moves it automatically.
- Bun is outside Herdr's server `PATH`: make `bun` available to the Herdr server. All actions invoke Bun directly, including on Windows.
- Manual label stays: use `reset-tab` or an explicit rename.
- Explicit actions report the skip or failure reason. Provider failures exit nonzero. `status` checks the worker process, not provider health.
- Action logs: `herdr plugin log list --plugin tab-smart-rename --limit 10`
- Background failures: `~/.local/state/herdr/plugins/tab-smart-rename/worker.log`

## Development checks

```sh
bun install --frozen-lockfile
bun run check
bun test
```

On this Mac, run host-isolated checks instead:

```sh
bun scripts/test-contained.ts
bun scripts/test-contained.ts --harness test/harness-runtime.test.ts
```

The macOS runner blocks source and home writes and external network access. It supplies temporary homes and fake credentials. The harness check uses the installed OpenCode executable and Pi runtime against a local fake provider, including an OpenCode tool-denial sentinel. Test directories remain as evidence.

From a Herdr pane, run the opt-in integration checks:

```sh
SMART_RENAME_LIVE_TEST=1 bun test test/herdr-live.test.ts
```

These tests create background tabs, report fixture agent states, and close only their own tabs. They use a local mock provider, not a billed API. They cover pane closure during inference, manual-label protection, exact action scope, and CLI failure cleanup.

## Documentation

- [Naming policy](docs/naming-policy.md)
- [Release process](docs/releasing.md)
- [Changelog](CHANGELOG.md)
- [Semantic map](ai-artifacts/SEMANTIC_MAP.md)
- [Architecture](ai-artifacts/ARCHITECTURE.md)
