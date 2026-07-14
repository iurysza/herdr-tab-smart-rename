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

Obvious processes get instant deterministic names. Ambiguous work can use Kimi Code or another OpenAI-compatible model.

## Install

Requires Herdr 0.7.0 or newer and Bun 1.1.34 or newer.

```sh
herdr plugin install iurysza/herdr-tab-smart-rename
herdr plugin action invoke configure-ai --plugin autoname
herdr plugin action invoke check-ai --plugin autoname
herdr plugin action invoke start --plugin autoname
```

`configure-ai` opens the private `provider.env` file. Kimi Code needs one line:

```dotenv
SMART_RENAME_API_KEY=...
```

Without a key, deterministic names still work. Model-backed names do not.

## Use

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

| Action | What it does |
| --- | --- |
| `rename-now` | Rename the current tab now |
| `rename-all` | Rename every tab in sequence |
| `reset-tab` | Return the current tab to automatic naming |
| `reset-workspace` | Return the current workspace to automatic naming |
| `configure-ai` | Edit provider settings |
| `check-ai` | Check settings without making a model request |
| `start` / `stop` / `status` | Control or inspect Smart Rename |

Run any action with:

```sh
herdr plugin action invoke <action> --plugin autoname
```

Explicit rename actions reclaim manual tabs and request fresh names.

## Naming rules

Smart Rename uses the most relevant pane in each tab:

1. the focused agent;
2. another working or blocked agent;
3. the focused command;
4. the first pane.

Tests, development servers, log followers, and remote shells become `Run Tests`, `Dev Server`, `View Logs`, and `Remote Shell`. Agent tasks and unclear commands may use the configured model.

Labels use 2 to 4 Title Case words and no more than 30 characters. Workspaces describe projects. Tabs describe tasks. Manual names always win until you reset or explicitly rename them.

See the [naming policy](docs/naming-policy.md) for the full contract.

## Choose a provider and model

Kimi Code is the default:

```dotenv
SMART_RENAME_PROVIDER=kimi-code
SMART_RENAME_BASE_URL=https://api.kimi.com/coding/v1
SMART_RENAME_MODEL=kimi-for-coding
SMART_RENAME_REASONING_EFFORT=medium
SMART_RENAME_TIMEOUT_MS=45000
```

Set the endpoint, provider name, model, and `SMART_RENAME_API_KEY` to use another OpenAI-compatible provider. `KIMI_API_KEY` also works for Kimi. Reasoning effort accepts `low`, `medium`, or `high` when the provider supports it.

Smart Rename reloads this file before every model request. You do not need to restart the worker after changing it.

## Privacy

Smart Rename sends only bounded, sanitized task context to the configured provider. It removes terminal controls, common credential forms, and local home paths before a request.

For detected Pi panes, it can sample user requests from the local session file. It never starts Pi, reads Pi credentials, or uses Pi for inference. Sibling panes contribute process summaries only.

Provider keys stay in Herdr's private plugin config directory. Smart Rename does not write them to state or logs.

## Troubleshooting

- Worker stopped: `herdr plugin action invoke start --plugin autoname`
- Provider missing: run `configure-ai`, save the key, then run `check-ai`.
- Manual label stays unchanged: use `reset-tab` or an explicit rename action.
- No model name appears: the model may have found no meaningful task.
- Worker logs: `herdr plugin log list --plugin autoname --limit 10`

## Project documentation

- [Semantic map](ai-artifacts/SEMANTIC_MAP.md)
- [Architecture](ai-artifacts/ARCHITECTURE.md)
- [Naming policy](docs/naming-policy.md)
