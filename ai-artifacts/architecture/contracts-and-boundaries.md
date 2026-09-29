# Contracts and boundaries

This reference maps the naming vocabulary to runtime types and external input boundaries. Code excerpts show existing contracts, not new APIs.

[Knowledge base](../README.md) · [Overview](../ARCHITECTURE.md) · [Glossary](../CONTEXT.md)

## Naming input and output

[domain.ts](../../src/domain.ts) defines mutually exclusive outgoing context shapes. `PaneContext` contains collected evidence; `NamingContext` is the selected, sanitized payload sent to inference.

```ts
export type NamingContext =
	| { project: string; sessionTimeline: SessionTimeline }
	| { project: string; userRequests: string[] }
	| {
		project: string;
		focusedPane: ProcessEvidence;
		siblingPanes?: SiblingEvidence[];
	};

export interface NameSuggestion {
	tab: string | null;
	reason: string;
}

export interface RenameOutcome {
	kind: RenameChange["kind"];
	id: string;
	status: "renamed" | "unchanged" | "skipped" | "failed";
	reason: string;
}
```

`SessionTimeline` contains `origin`, `middle`, and `recent` string arrays. `ProcessEvidence` contains process information and recent output; `SiblingEvidence` contains a label and process information. Those component types also live in `domain.ts`.

The `tab` response field is reused for pane naming. `RenameResult` combines candidates, applied changes, ownership flags, and per-target outcomes for one tab evaluation. It is not equivalent to a single `NameSuggestion`.

[Namer](../../src/provider.ts) is the service's inference seam:

```ts
export interface Namer {
	suggest(context: NamingContext): Promise<NameSuggestion>;
	close?(): Promise<void>;
}
```

Rejected promises represent inference failures. `{ tab: null, reason }` represents an abstention. The service converts target-level failures into `RenameOutcome` records and continues with other targets.

## Model adapter contract

[model-source.ts](../../src/model-source.ts) defines discovery, validation, and completion separately:

```ts
export interface ModelSelection {
	version: 1;
	source: ModelSourceId;
	provider: string;
	model: string;
	profile?: string | undefined;
}

export interface ModelCompletionRequest {
	selection: ModelSelection;
	context: NamingContext;
	system: string;
	prompt: string;
	maxOutputTokens: number;
	maxRetries: number;
	abortSignal: AbortSignal;
}

export interface ModelSource {
	readonly id: ModelSourceId;
	listProviders(): Promise<readonly ProviderChoice[]>;
	listModels(providerId: string): Promise<readonly ModelChoice[]>;
	listProfiles(providerId: string, modelId: string): Promise<readonly ModelProfile[]>;
	validate(selection: ModelSelection): Promise<void>;
	complete(request: ModelCompletionRequest): Promise<string>;
	close?(): Promise<void>;
}
```

`ModelSourceId` is `"direct" | "pi" | "opencode"`. Choice types contain an `id` and `label`. `ModelSourceError.kind` distinguishes source, provider, model, profile, authentication, and request failures. The common decoder validates returned text before the service sees a `NameSuggestion`.

Direct implements the discovery interface for setup, but the naming router delegates Direct suggestions to `AiSdkNamer`. [Model sources and setup](model-sources-and-setup.md) explains the different execution and cancellation paths.

## External input and effect boundaries

| Boundary | Parse or transformation | Failure behavior | Evidence |
| --- | --- | --- | --- |
| Herdr command JSON | Command-specific Zod schema produces snapshot or process types | Invalid snapshot fails the operation; process-info failure becomes no process evidence | [herdr.ts](../../src/herdr.ts), [context tests](../../test/context.test.ts) |
| Herdr socket | LF framing, JSON parse, `normalizeHerdrEvent` | Invalid lines or envelopes are ignored; socket closure triggers reconnect | [herdr.ts](../../src/herdr.ts), [worker.ts](../../src/worker.ts) |
| Session path or Claude session ID | Resolve a unique permitted file, canonicalize path, require a regular file under allowed roots | Missing, ambiguous, or disallowed paths yield no session evidence | [pi-context.ts](../../src/pi-context.ts), [context tests](../../test/context.test.ts) |
| Session JSONL | Bounded head, middle, and tail reads; user-record schemas; wrapper filtering | Invalid individual records are skipped | [pi-context.ts](../../src/pi-context.ts) |
| Model context | `buildModelContext`, `boundedText`, hard serialized-size check | Throws if reduced context still exceeds the hard cap | [domain.ts](../../src/domain.ts), [domain tests](../../test/domain.test.ts) |
| Model response | Optional fence extraction, Effect Schema JSON decoding, label validation | `ModelOutputError`, projected as request failure by callers | [model-output.ts](../../src/effect/model-output.ts), [provider tests](../../test/provider.test.ts) |
| Saved selection | Strict, versioned Zod schema and validated environment overrides | Missing file uses Direct; malformed selection fails | [model-selection.ts](../../src/model-selection.ts), [selection tests](../../test/model-selection.test.ts) |
| Direct settings and prompt | Bounded file reads, precedence resolution, configuration schema | Invalid configuration or prompt fails the request | [provider.ts](../../src/provider.ts), [configuration](../../docs/configuration.md) |
| Naming state | Merge defaults and validate known fields; retain extra top-level fields | Missing file starts empty; read, JSON, or field-validation errors propagate | [storage.ts](../../src/storage.ts) |
| Herdr rename | Final snapshot checks, expected-write persistence, command execution | Command failure restores prior ownership record; does not roll back other successful targets | [service.ts](../../src/service.ts), [reliability tests](../../test/reliability.test.ts) |

The lint policy recognizes some intentional unknown-valued boundaries, including extensible state and the AI SDK body transform. Those exceptions do not replace runtime parsing. [Vendored rule notes](../../tools/oxlint/anti-slop/UPSTREAM.md) and [policy regression tests](../../test/anti-slop-policy.test.ts) describe their limits.

## Private files and persisted identities

`statePaths` in [storage.ts](../../src/storage.ts) derives the following records from the Herdr-provided state directory:

| Record | Owner and purpose |
| --- | --- |
| `state.json` | Ownership, attempts, retries, named sessions, fingerprints, and current decision IDs |
| `state.lock` | Cross-process state transaction lock with PID and nonce |
| `start.lock` | Serializes worker startup |
| `worker.json` | PID, script, start timestamp, target socket, and readiness timestamp |
| `worker.log` | Worker events and failures; no built-in rotation |

Configuration is separate from those records. `model-selection.json` contains source metadata, `provider.env` holds private Direct settings, and `naming-prompt.md` can override the bundled prompt. Configuration writes use private directories and files; POSIX modes are not a substitute for every platform's access-control model.

## Privacy and assurance limits

`sanitizeText` strips ANSI sequences and redacts recognized secret forms. It cannot guarantee that all sensitive text is removed. Sampling excludes most transcript content, and the final context cap constrains what reaches a provider, but neither proves confidentiality.

Manual ownership controls label writes, not evidence collection. Pi and Claude Code session readers constrain file paths and sample user text; Pi as an inference source separately uses Pi's authenticated runtime. These are different capabilities despite sharing the Pi name.

The normal test suite uses fixtures and fake providers. [Real-runtime tests](../../test/harness-runtime.test.ts) and [live Herdr tests](../../test/herdr-live.test.ts) are opt-in. Passing normal CI does not claim that those integrations were exercised. Use the [development guide](../../docs/development.md) for safe test modes.
