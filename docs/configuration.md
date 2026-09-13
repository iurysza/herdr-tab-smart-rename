# Configuration and controls

Use [setup](install.md#choose-a-model) for model selection. These settings and actions cover the rest.

## Actions

Run an action from a Herdr terminal:

```sh
herdr plugin action invoke rename-now --plugin tab-smart-rename
```

Replace `rename-now` with the action you need:

| Action | Effect |
| --- | --- |
| `rename-now` | Reclaim and rename only the current tab |
| `rename-all` | Reclaim and rename all tabs, including manually named tabs |
| `reset-tab` | Return the current tab to automatic naming |
| `reset-pane` | Reclaim and rename only the current agent pane |
| `reset-workspace` | Reclaim and rename only the current workspace |
| `setup` | Choose a model, validate settings, and start the worker |
| `configure-prompt` | Open your private naming instructions |
| `check-ai` | Validate model configuration and prompt without a completion |
| `start` | Start the worker for this Herdr session |
| `stop` | Stop the worker |
| `status` | Check the worker process and its Herdr session |

`configure-ai` remains an alias for `setup`. Tab actions leave pane and workspace labels alone.

Explicit renames end with a notification showing the result or failure. A diamond pulse marks a model-backed `rename-now`; background naming does not show it.

## Shortcuts

Setup can show these bindings and warn about conflicts. It does not write or reload Herdr configuration.

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

The second binding intentionally reclaims manually named tabs too.

## Naming preferences

`configure-prompt` opens a private copy of the [default naming policy](naming-policy.md). The file is `naming-prompt.md` inside the plugin config directory.

A short prompt can be enough:

```text
Name the current task in 2–4 Title Case words.
Omit project, app, agent, and model names.
Return JSON only: {"tab":"Assess Python Migration","reason":"Current task."}
If unclear: {"tab":null,"reason":"no meaningful task"}
```

`SMART_RENAME_PROMPT_PATH` selects another absolute or config-relative file. Prompt edits apply on the next model request. JSON and label validation still apply.

## Model sources

| Source | Provider access | Runtime behavior |
| --- | --- | --- |
| Pi | Pi's connected providers and `models.json` definitions | Uses Pi's model runtime, without a Pi agent, tools, or extensions |
| OpenCode | Providers connected in the installed OpenCode executable | Uses temporary sessions with tool execution denied |
| Direct | Smart Rename's private OpenAI-compatible API configuration | Uses the existing AI SDK request path |

Pi and OpenCode keep their own credentials. Setup stores only the source, provider, model, and optional thinking level or variant in `model-selection.json`.

Selection reloads before each model-backed rename. If the selected source fails, Smart Rename reports the failure rather than switching providers. OpenCode may send tool definitions to the provider, but tool execution stays denied.

## Direct settings

Direct keeps working without `model-selection.json`. Existing `provider.env` settings are read before every request.

The private file starts from [`provider.env.example`](../provider.env.example). Process settings override the private file, which overrides registered provider defaults.

Known Direct providers are defined in a registry that can supply endpoint, model, reasoning, and key-variable defaults. OpenAI is the default profile. Providers not in the registry remain supported when their OpenAI-compatible endpoint, model, and key are configured explicitly.

| Setting | Purpose |
| --- | --- |
| `SMART_RENAME_PROVIDER` | Provider name |
| `SMART_RENAME_BASE_URL` | OpenAI-compatible endpoint |
| `SMART_RENAME_MODEL` | Model ID |
| `SMART_RENAME_API_KEY` | API key |
| `SMART_RENAME_REASONING_EFFORT` | Reasoning level; an empty value disables it |
| `SMART_RENAME_TIMEOUT_MS` | Request timeout in milliseconds |
| `SMART_RENAME_PROMPT_PATH` | Custom naming prompt |

`OPENAI_API_KEY` and `KIMI_API_KEY` are also accepted for their respective providers. Keep keys out of the installed checkout and Git.

## Private files and context

Find the config directory with:

```sh
herdr plugin config-dir tab-smart-rename
```

`provider.env`, `model-selection.json`, and the optional `naming-prompt.md` live there, separate from the installed code. Ownership state and worker logs live in the plugin state directory.

Tab naming uses the dominant pane's task context, with sibling process summaries as supporting evidence. Agent-pane naming uses that pane alone. Pi and Claude Code panes can contribute short user-request excerpts.

A manual name protects the label, not its pane content from use as tab context. Smart Rename removes terminal formatting, common secret patterns, and the local home path before sending bounded context. Redaction is best-effort, not a guarantee that all sensitive text is detected.

## Troubleshooting

| Problem | Next step |
| --- | --- |
| Worker stopped | Run `start` |
| Model configuration invalid | Run `setup` |
| Pi or OpenCode provider missing | Connect it in that tool, then rerun setup |
| Direct authentication fails | Check the endpoint and key; `check-ai` does not test a completion |
| Bun not found | Make Bun available on the Herdr server's `PATH` |
| Manual name stays unchanged | Use the matching reset action or an explicit rename |
| Worker serves another Herdr socket | Stop it in that session before starting it here |

`status` checks the worker, not provider health. A successful `check-ai` confirms configuration, not a successful model response.

Inspect recent action results with:

```sh
herdr plugin log list --plugin tab-smart-rename --limit 10
```

On macOS and Linux, background failures are normally logged in `~/.local/state/herdr/plugins/tab-smart-rename/worker.log`. Logs are not rotated automatically.
