# Naming policy

This is the human-readable contract for Smart Rename. If the implementation and this file disagree, treat that as a bug.

## Goals

- Workspaces describe stable project identity.
- Tabs describe the current persistent task.
- Manual names always win.
- Prefer no rename over a weak or noisy guess.

## Ownership

Smart Rename owns only default labels or labels it previously generated.

- Any meaningful pre-existing label is manual.
- Any rename that does not match Smart Rename's expected write becomes manual.
- Manual workspaces and tabs are not inspected, sent to Kimi, or renamed.
- Reset actions explicitly return ownership to Smart Rename.

## Workspace names

Workspace names should remain stable while tabs and tasks change.

Identity is selected in this order:

1. Herdr worktree repository name.
2. Existing meaningful workspace name.
3. Git repository root.
4. Stable workspace pane directory.

A focused cross-project tab must not change the workspace name.

## Tab names

A tab name must:

- describe the task, not the tool or actor;
- use 2–4 words;
- be at most 30 characters;
- use readable Title Case while preserving acronyms;
- omit model, agent, app, and project prefixes.

Good examples:

- `Review Auth Changes`
- `Repair Tab Ownership`
- `Run Tests`
- `Dev Server`
- `View API Logs`

Bad examples:

- `Kimi · VAR Review`
- `Pi Coding Agent`
- `Obsidian Vault` when that is only the project name
- `Dev Server` when an active agent in the same tab is doing a broader task

## Dominant pane

One pane supplies the main naming evidence. Selection order:

1. Focused detected agent.
2. Any working or blocked detected agent.
3. Focused ordinary command.
4. First pane.

Supporting servers, logs, and shells must not replace an active agent's task name.

Sibling panes may provide bounded process summaries, but never agent conversation content.

## Naming flow

1. Manual ownership short-circuits all inspection.
2. Select the dominant pane.
3. Use deterministic names for recognized processes:
   - test runners → `Run Tests`;
   - development servers → `Dev Server`;
   - log followers → `View Logs`;
   - SSH or Mosh → `Remote Shell`.
4. For a detected agent with user task evidence, ask Kimi immediately.
5. Agent session evidence is weighted across the timeline: first request, one midpoint request, and the latest four requests. Recent requests win when the task changed.
6. For an unclear ordinary command, wait until the sanitized context is unchanged across two observations, then ask Kimi.
7. Kimi may return `null` when there is no meaningful task. In that case, keep the current/default label.
8. Never rename when the candidate equals the current label.

Broad AI naming remains enabled for ordinary commands. Stability and abstention guard against shell-startup noise and project-name guesses.

## Timing and churn control

- Relevant Herdr lifecycle events are debounced briefly.
- A serialized sweep runs every 60 seconds for task changes without events.
- Kimi attempts are limited to once per tab every 10 minutes.
- An unchanged successful context fingerprint is not sent again.
- Manual overrides remain locked across restarts.

A strong deterministic process transition can rename immediately. A weak AI-derived transition should wait for stable evidence.

## Kimi input

Kimi receives at most 4,500 serialized characters of sanitized context.

- Detected focused Pi agent: one origin request, one midpoint request, and up to four recent user requests.
- Ordinary focused command: bounded process data and recent output.
- Sibling panes: bounded process summaries only.
- Environment values are never added.
- Common credential shapes are redacted best-effort.

## Feedback prompts

When reviewing this policy, the useful questions are:

- Which pane should win in your common layouts?
- Which processes deserve deterministic labels?
- Which generated labels are too generic or too specific?
- How long should a task remain stable before its label changes?
- Should any existing meaningful labels be auto-owned rather than manual?
