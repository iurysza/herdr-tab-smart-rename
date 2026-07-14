# Semantic map

Smart Rename turns live Herdr activity into stable workspace names and current-task tab names. The code separates naming policy from context collection, provider access, persistence, and runtime control.

## Domain Concepts

| Concept | Meaning | Owner |
| --- | --- | --- |
| Workspace identity | Stable project identity from the worktree, existing label, Git root, or pane directory | `domain.ts` |
| Tab task | The current persistent task, expressed as a 2 to 4 word label | `domain.ts` |
| Ownership | Whether Smart Rename or the user controls a label | `domain.ts`, `storage.ts` |
| Expected write | A rename recorded before Herdr applies it, so its event is not mistaken for a manual rename | `domain.ts`, `service.ts` |
| Dominant pane | The pane that supplies task evidence: focused agent, active agent, focused command, then first pane | `service.ts` |
| Naming context | Bounded project, process, terminal, and optional Pi session evidence sent to the namer | `domain.ts`, `herdr.ts`, `pi-context.ts` |
| Name suggestion | A validated label and reason, or `null` when evidence does not describe a task | `provider.ts` |
| Rename result | Candidate names, ownership state, model usage, reason, and applied changes | `domain.ts`, `service.ts` |
| Churn gate | Fingerprints, stability observations, and model cooldowns that prevent repeated calls | `domain.ts` |
| Provider configuration | Tracked defaults plus private endpoint, model, key, timeout, reasoning, and prompt-path overrides | `provider.env.example`, `provider.ts`, `configure.ts` |
| Naming prompt | Bundled policy or user-owned instructions reloaded before each model request | `docs/naming-policy.md`, `provider.ts` |

## Technical Layers

```mermaid
flowchart TB
    E[CLI, configure pane, worker] --> S[AutoNameService]
    S --> D[Domain policy]
    S --> H[Herdr adapter]
    S --> P[AI provider]
    S --> ST[State and locks]
    H --> PI[Optional Pi context]
    D --> T[Text sanitization]
    H --> T
    P --> T
```

| Layer | Files | Responsibility |
| --- | --- | --- |
| Entrypoints | `cli.ts`, `configure.ts`, `worker.ts` | Translate Herdr actions and events into service calls |
| Orchestration | `service.ts` | Reconcile ownership, collect context, choose a naming path, and apply safe writes |
| Domain | `domain.ts` | Hold pure naming, ownership, validation, context, and churn rules |
| Herdr integration | `herdr.ts` | Run Herdr commands, validate snapshots, inspect panes, rename labels, and frame socket events |
| Pi context | `pi-context.ts` | Read bounded user requests from allowed Pi session files |
| Provider | `provider.ts` | Merge exposed defaults and overrides, reload the naming prompt, call one OpenAI-compatible model, and validate its answer |
| Persistence | `storage.ts` | Validate state, write atomically, serialize processes, and verify the singleton worker |
| Text safety | `text.ts` | Strip terminal controls, redact secrets, normalize paths, and bound text |

## Cross-Cutting Concerns

- Manual ownership: manual labels stop inspection, provider calls, and writes until reset or explicit reclaim.
- Bounded data: terminal output, process fields, session windows, provider files, prompts, errors, and notifications all have limits.
- Secret safety: `strip-ansi` and `secret-sniff` handle common terminal and credential forms before data leaves the machine.
- Runtime validation: Zod validates Herdr JSON, Pi records, provider configuration, model output, state, locks, and worker metadata.
- Concurrency: one cross-process state lock covers reconciliation, model gates, expected writes, and rename rollback.
- Resilience: the worker serializes tasks, debounces tab events, sweeps every 60 seconds, and reconnects after socket closure.
- Provider independence: Pi supplies optional context only. Model authentication comes from Smart Rename's private provider file.
- User customization: provider and prompt files reload per request; fixed schemas still reject unsafe or malformed output.
- Feedback: explicit actions emit start, success, no-change, and sanitized failure notifications.

## Data Flow Paths

### Explicit rename

```mermaid
sequenceDiagram
    participant U as User
    participant C as CLI action
    participant S as AutoNameService
    participant H as Herdr
    participant N as Namer
    participant F as State file

    U->>C: rename-now or rename-all
    C->>S: evaluate with reclaim and refresh
    S->>F: lock, load, reconcile
    S->>H: snapshot and pane evidence
    alt deterministic process
        S->>S: choose fixed label
    else ambiguous task
        S->>N: bounded NamingContext
        N-->>S: NameSuggestion
    end
    S->>F: persist expected label
    S->>H: rename workspace or tab
    H-->>S: rename event
    S->>F: confirm automatic ownership
    C-->>U: result notification
```

### Background naming

1. `worker.ts` subscribes to Herdr lifecycle events.
2. It resolves the affected tab and debounces evaluation by 400 milliseconds.
3. `AutoNameService` runs evaluations through one promise queue and one state transaction at a time.
4. A 60-second sweep catches task changes without lifecycle events.
5. Fingerprints and cooldowns suppress unchanged model work.

### Provider configuration

1. `provider.env.example` supplies the tracked OpenAI Luna defaults.
2. `configure-ai` copies that template to private `provider.env` on first use and opens it in Herdr's overlay pane.
3. Process values override private-file values; private-file values override the tracked defaults.
4. `provider.ts` reads at most 16 KiB and validates the merged configuration with Zod.
5. It loads an explicit prompt path, private `naming-prompt.md`, or bundled `docs/naming-policy.md` in that order.
6. The AI SDK sends one non-streaming OpenAI-compatible request.

### Prompt customization

1. `configure-prompt` copies the bundled naming policy to private `naming-prompt.md` on first use.
2. `SMART_RENAME_PROMPT_PATH` may select another absolute or config-relative file.
3. The selected prompt is limited to 32 KiB and reloaded before every request.
4. The model response must still pass JSON, Zod, and label-policy validation.

## Data Boundaries and Transformations

| Boundary | Input | Transformation | Output |
| --- | --- | --- | --- |
| Herdr snapshot | CLI JSON | JSON parse and Zod validation | `HerdrSnapshot` |
| Herdr event socket | LF-delimited envelopes | framing, JSON parse, normalization, Zod validation | `HerdrEvent` |
| Pane process | Herdr process-info JSON | field selection, sanitization, length limits | `ProcessInfo` |
| Pane output | recent terminal text | ANSI removal, secret redaction, whitespace normalization, 1,000-character cap | safe output evidence |
| Pi session | path-backed JSONL | root check, regular-file check, bounded head/middle/tail windows, user-message validation | `SessionTimeline` |
| Provider files | tracked and private dotenv text | 16 KiB bounds, dotenv parse, precedence merge, provider-specific key selection, Zod validation | `ProviderConfig` |
| Naming prompt | bundled policy, private copy, or configured path | precedence selection, 32 KiB bound, non-empty check | system instruction text |
| Model context | pane evidence | dominant-pane selection, sanitization, timeline weighting, 4,500-character hard cap | `NamingContext` |
| Model response | provider text | JSON fence removal, JSON parse, Zod validation, title policy | `NameSuggestion` |
| State file | JSON on disk | lock, Zod validation, reconciliation, atomic temporary-file rename | `SmartRenameState` |
| Herdr rename | candidate label | expected-write persistence before command | confirmed automatic ownership or rollback |

Updated-at: 965b2ab6bf3c83760aea70fa6de27bc0972e0fcf
