# Naming policy

This is both the human-readable contract and the default AI system prompt for Smart Rename. If the implementation and this file disagree, treat that as a bug.

The model's job is narrow: choose a tab label from sanitized context or abstain. Smart Rename itself enforces ownership, deterministic names, timing, and validation.

## Goals

- Workspaces describe stable project identity.
- Tabs describe the current persistent task.
- Manual names always win.
- Prefer no rename over a weak or noisy guess.

## Ownership

Smart Rename owns only default labels or labels it previously generated.

- Any meaningful pre-existing label is manual.
- Any rename that does not match Smart Rename's expected write becomes manual.
- Manual workspaces and tabs are not inspected, sent to the AI provider, or renamed.
- Reset and explicit rename actions return their target tabs to Smart Rename ownership.

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
4. For a detected agent with user task evidence, ask the configured model immediately.
5. Agent session evidence is weighted across the timeline: first request, one midpoint request, and the latest four requests. Recent requests win when the task changed.
6. For an unclear ordinary command, wait until the sanitized context is unchanged across two observations, then ask the configured model.
7. The model may return `null` when there is no meaningful task. In that case, keep the current/default label.
8. Never rename when the candidate equals the current label.

Broad AI naming remains enabled for ordinary commands. Stability and abstention guard against shell-startup noise and project-name guesses.

## Timing and churn control

- Relevant Herdr lifecycle events are debounced briefly.
- A serialized sweep runs every 60 seconds for task changes without events.
- Background model attempts are limited to once per tab every 10 minutes.
- Background evaluation does not resend an unchanged successful context fingerprint.
- Explicit current-tab and all-tab actions bypass both limits and request fresh names.
- Manual overrides remain locked across restarts. Explicit current/all rename actions are user-approved overrides: they reclaim their target tabs and bypass model cooldown.

A strong deterministic process transition can rename immediately. A weak AI-derived transition should wait for stable evidence.

## Model input

The configured OpenAI-compatible model receives at most 4,500 serialized characters of sanitized context. OpenAI GPT-5.6 Luna is the default model. Pi session sampling is context collection only; Smart Rename does not invoke Pi as a model provider.

- Detected focused Pi agent: one origin request, one midpoint request, and up to four recent user requests.
- Ordinary focused command: bounded process data and recent output.
- Sibling panes: bounded process summaries only.
- Environment values are never added.
- Common credential shapes are redacted best-effort.

## Model response

When given naming context, return exactly one JSON object and no Markdown:

```json
{"tab":"Review Auth Changes","reason":"The user is reviewing authentication changes."}
```

When the context has no clear persistent task, abstain:

```json
{"tab":null,"reason":"no meaningful task"}
```

Prefer explicit user requests. Use origin and midpoint requests for continuity, but let recent requests win when the task changed. Ignore confirmations and operational follow-ups. Do not invent specificity or repeat the project name as the task.

## Feedback prompts

When reviewing this policy, the useful questions are:

- Which pane should win in your common layouts?
- Which processes deserve deterministic labels?
- Which generated labels are too generic or too specific?
- How long should a task remain stable before its label changes?
- Should any existing meaningful labels be auto-owned rather than manual?
