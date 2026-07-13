<p align="center">
  <img src="assets/herdr-tab-smart-rename-banner.png" width="720" alt="Magic wand naming a Herdr tab">
</p>

<h1 align="center">herdr-tab-smart-rename</h1>

<p align="center"><strong>Herdr tabs that say what the work is.</strong></p>

Smart Rename replaces default workspace and tab labels with short, context-aware names. User-chosen names stay untouched.

```text
3  ->  Repair Tab Ownership
4  ->  Run Tests
5  ->  Dev Server
```

Workspaces describe the project. Tabs describe the task. Smart Rename uses process heuristics for obvious commands and Kimi for ambiguous work.

## Requirements

| Dependency | Requirement |
| --- | --- |
| Herdr | 0.7.0 or newer |
| Node.js | 20 or newer |
| Pi | `kimi-coding/kimi-for-coding` configured and authenticated |

## Install

From GitHub:

```sh
herdr plugin install iurysza/herdr-tab-smart-rename
herdr plugin action invoke start --plugin autoname
```

For local development:

```sh
herdr plugin link /path/to/herdr-tab-smart-rename
herdr plugin action invoke start --plugin autoname
```

Linking registers the plugin but does not start it. Smart Rename runs as a detached worker only after the `start` action; it does not install a launchd service.

## What gets named

| Context | Example label |
| --- | --- |
| Agent working on a persistent task | `Review Auth Changes` |
| Vitest, Jest, Pytest, or another test runner | `Run Tests` |
| Vite, Next.js, Webpack, or another dev server | `Dev Server` |
| `tail`, `journalctl`, or `docker logs` | `View Logs` |
| SSH or Mosh | `Remote Shell` |
| Ambiguous command with enough context | Kimi-generated task label |
| No meaningful task | Existing/default label stays unchanged |

Labels use 2–4 words, readable Title Case, and at most 30 characters. Model, agent, app, and project prefixes are excluded.

The complete contract lives in [`docs/naming-policy.md`](docs/naming-policy.md). That file is the source of truth for naming behavior and feedback.

## How naming works

Smart Rename selects one dominant pane per tab:

1. Focused detected agent.
2. Any working or blocked detected agent.
3. Focused ordinary command.
4. First pane.

Supporting servers and logs do not displace an active agent task.

Recognized processes get deterministic labels. Agent tasks and unclear commands may go to Kimi. Weak command context must remain stable across two observations before a model call, and Kimi may abstain when the context does not contain a real task.

A serialized sweep runs every 60 seconds to catch task changes that do not emit Herdr lifecycle events. Successful context fingerprints are not sent again. Model attempts are limited to once per tab every ten minutes.

## Manual names win

Smart Rename owns only default labels and labels it previously generated.

Before renaming, it records the expected label. A matching Herdr rename event confirms automatic ownership; any other rename locks the item as manual. Manual tabs skip process inspection, session reads, and Kimi calls until reset.

Ownership survives worker restarts. Explicit `rename-now` and `rename-all` actions count as user approval to reclaim their target tabs, bypass model cooldown, and generate fresh names.

## Actions

| Action | Behavior |
| --- | --- |
| `start` | Start one detached worker. Repeated starts are harmless. |
| `stop` | Stop the verified worker process. |
| `status` | Report worker status. |
| `rename-now` | Reclaim and rename the current tab immediately. |
| `rename-all` | Reclaim and rename every tab sequentially. |
| `reset-tab` | Return the current tab to automatic ownership and evaluate it. |
| `reset-workspace` | Return the current workspace to automatic ownership and evaluate it. |

Invoke actions from Herdr's action picker or the CLI:

```sh
herdr plugin action invoke status --plugin autoname
herdr plugin action invoke rename-now --plugin autoname
herdr plugin action invoke rename-all --plugin autoname
herdr plugin action invoke stop --plugin autoname
```

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

## Context and privacy

Kimi receives at most 4,500 serialized characters of sanitized context.

For a detected Pi agent, Smart Rename samples three bounded parts of the session file:

- the first user request;
- one user request near the midpoint;
- up to four recent user requests.

Recent requests win when the task changed. Assistant messages are excluded.

For ordinary commands, Smart Rename uses bounded process details and a small recent-output sample. Sibling panes contribute process summaries only; their session content is never read.

Smart Rename does not add environment values to prompts. It removes terminal escapes, normalizes home paths, and redacts common credential forms on a best-effort basis. Pi runs without sessions, tools, skills, prompt templates, themes, or project context files. Normal extension loading remains enabled for the Kimi OAuth provider.

## Dry run

Preview the current tab without renaming it or changing ownership state:

```sh
node src/cli.mjs dry-run
```

A dry run may call Kimi. It respects existing manual locks when plugin state is available.

## Refresh and failure behavior

- Reconnects when the Herdr socket closes.
- Serializes worker and action state updates with a cross-process lock.
- Recovers stale state locks and stale worker PID files.
- Leaves labels unchanged when Kimi abstains or fails.
- Retries failed model requests after the ten-minute backoff.
- Uses one fresh Pi RPC process per model request.

Runtime state and logs live under:

```text
~/.local/state/herdr/plugins/autoname/
```

## Development

```sh
npm run check
npm test
```

Smart Rename has no runtime npm dependencies. Herdr socket, Pi RPC, and Pi session JSONL are framed on LF only.

## Troubleshooting

- Worker not running: `herdr plugin action invoke start --plugin autoname`
- Current label never changes: check whether it is manual-locked; use `reset-tab` if AutoName should own it.
- Kimi authentication failure: authenticate `kimi-coding/kimi-for-coding` in Pi.
- Unexpected model label: run `node src/cli.mjs dry-run` and review [`docs/naming-policy.md`](docs/naming-policy.md).
- Worker details: `herdr plugin log list --plugin autoname --limit 10`

## Limitations

- V1 uses the local Herdr socket inherited by the start action; remote and named multi-session socket discovery is not automatic.
- Closed tab and workspace records are not pruned yet.
- Worker logs are not rotated.
- Redaction is a guardrail, not a universal secret detector.
