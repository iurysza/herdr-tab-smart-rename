# Herdr AutoName

A conservative Herdr plugin that keeps default workspace and tab labels useful.

- **Workspace:** stable project/repository identity.
- **Tab:** task only, 2–4 Title Case words, at most 30 characters.
- Existing meaningful names are treated as manual overrides.
- A manual rename locks that item until its reset action runs.

Requires Herdr 0.7.0+, Node.js 20+, and Pi configured with `kimi-coding/kimi-for-coding`.

## Install

From GitHub:

```sh
herdr plugin install iurysza/herdr-autoname
```

Local development:

```sh
herdr plugin link /path/to/herdr-autoname
```

Linking only registers the plugin. Run **AutoName: start** from Herdr's action picker to start it. AutoName does not use launchd or start itself during installation.

## Actions

| Action | Behavior |
| --- | --- |
| `start` | Start one detached worker. Repeated starts are harmless. |
| `stop` | Stop the verified worker process. |
| `status` | Report whether the worker is running. |
| `rename-now` | Evaluate the current tab and workspace, respecting manual locks. |
| `reset-tab` | Clear the current tab's manual lock, then evaluate it. |
| `reset-workspace` | Clear the current workspace's manual lock, then evaluate it. |

The worker reconnects when the Herdr socket closes. Lifecycle events trigger focused reconciliation, and a serialized 60-second sweep catches ordinary process/task changes that do not emit Herdr events. Each rate-limited model request uses a fresh Pi RPC process, avoiding session-replacement side effects from unrelated Pi extensions.

## Naming and ownership

Before issuing a rename, AutoName persists the expected label. A matching Herdr rename event acknowledges AutoName ownership. Any other rename event marks the item manual. On startup, a current label that differs from the persisted expected or automatic label is also marked manual.

Worker evaluations and action commands share a cross-process state lock. This prevents reset, rename acknowledgement, model fingerprints, and expected labels from overwriting each other. Stale lock owners and stale PID files are recovered.

Workspace identity prefers Herdr worktree repository metadata, then an existing meaningful workspace identity. Empty/numeric workspaces use a stable workspace pane's Git root or working directory. Workspace identity never follows the currently focused cross-project tab.

Tabs use process heuristics for obvious tests, dev servers, logs, and remote shells. Agent tabs and unclear commands use Kimi only when task evidence changed and the per-tab ten-minute attempt limit permits it. Manual-locked tabs skip pane/session reads and model calls entirely.

## Privacy

Model input is hard-capped at 4,500 serialized characters. AutoName never adds environment values to the prompt.

For a focused detected Pi pane, AutoName may read up to 512 KiB from the tail of a regular JSONL session file under Pi's configured sessions directory. It extracts only recent user messages. For ordinary commands it uses bounded foreground process data and a small recent-output sample. Sibling panes contribute bounded process summaries only.

Before prompting, AutoName removes terminal escapes, normalizes home paths, and performs best-effort redaction of common bearer credentials, key/token/secret/password assignments, credentialed URLs, and common token prefixes. This is a guardrail, not a general secret detector; do not print secrets into terminal output.

Pi runs without sessions, tools, skills, prompt templates, themes, or project context files. Normal extension discovery remains enabled because this machine's Kimi OAuth provider is supplied by the `pi-provider-kimi-code` extension.

## Dry run

Preview the current live Herdr tab without renaming or writing ownership state:

```sh
node src/cli.mjs dry-run
# equivalent
node src/cli.mjs once --dry-run
```

A dry run can call Kimi. If `HERDR_PLUGIN_STATE_DIR` is available, it reads ownership state without modifying it and respects manual locks.

For direct non-plugin lifecycle commands, provide the same values Herdr supplies to actions:

```sh
HERDR_PLUGIN_STATE_DIR=/tmp/autoname-state \
HERDR_SOCKET_PATH=/path/to/herdr.sock \
node src/cli.mjs status
```

## Development

```sh
npm run check
npm test
```

No runtime dependencies are used. Herdr socket JSONL, Pi RPC JSONL, and session JSONL are framed on LF only.

## Limitations

- V1 watches the local Herdr socket inherited by the start action; remote and multi-session socket discovery is not automatic.
- Meaningful pre-existing labels require an explicit reset before AutoName may own them.
- Model naming depends on local Pi/Kimi authentication and availability. Failed attempts back off for ten minutes.
- The worker log is not rotated in V1.
