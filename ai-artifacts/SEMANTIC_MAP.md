# Code and test map

Use this reference to locate the implementation and tests for a change. Start with the [knowledge-base index](README.md) for explanations and the [glossary](CONTEXT.md) for domain terms.

## Naming and runtime

| Behavior | Source | Regression evidence |
| --- | --- | --- |
| Ownership transitions, label policy, workspace identity, context bounds, model gates | [domain.ts](../src/domain.ts) | [domain.test.ts](../test/domain.test.ts) |
| Target scope, source-pane choice, context caching, decision IDs, guarded writes | [service.ts](../src/service.ts) | [service.test.ts](../test/service.test.ts), [reliability.test.ts](../test/reliability.test.ts) |
| First-request wait for Pi and Claude Code | [service.ts](../src/service.ts) | [agent-startup.test.ts](../test/agent-startup.test.ts) |
| Snapshots, socket framing, process info, rename commands, progress markers | [herdr.ts](../src/herdr.ts) | [herdr.test.ts](../test/herdr.test.ts), [progress.test.ts](../test/progress.test.ts), [context.test.ts](../test/context.test.ts) |
| Bounded Pi and Claude Code session reads | [pi-context.ts](../src/pi-context.ts) | [context.test.ts](../test/context.test.ts) |
| ANSI removal and best-effort redaction | [text.ts](../src/text.ts) | [domain.test.ts](../test/domain.test.ts) |
| State transactions, atomic files, locks, worker identity | [storage.ts](../src/storage.ts) | [runtime.test.ts](../test/runtime.test.ts), [service.test.ts](../test/service.test.ts) |
| Debounce, concurrent tab scheduling, event handling, reconnect, shutdown | [worker.ts](../src/worker.ts) | [worker-readiness.integration.test.ts](../test/worker-readiness.integration.test.ts), opt-in [herdr-live.test.ts](../test/herdr-live.test.ts) |
| Action dispatch, worker control, notices, and exit status | [cli.ts](../src/cli.ts) | [runtime.test.ts](../test/runtime.test.ts), opt-in [herdr-live.test.ts](../test/herdr-live.test.ts) |

Read [naming flow](architecture/naming-flow.md) for the call sequence and [ownership and concurrency](architecture/ownership-and-concurrency.md) before changing locks, request gates, or event handling.

## Inference and configuration

| Behavior | Source | Regression evidence |
| --- | --- | --- |
| Model-source contracts and typed failures | [model-source.ts](../src/model-source.ts) | Adapter tests below |
| Selection parsing, precedence, private atomic saves | [model-selection.ts](../src/model-selection.ts) | [model-selection.test.ts](../test/model-selection.test.ts) |
| Source routing, serialization, selection changes, no fallback | [model-namer.ts](../src/model-namer.ts), [source loader](../src/model-sources/index.ts) | [model-namer.test.ts](../test/model-namer.test.ts) |
| Direct discovery and validation | [direct.ts](../src/model-sources/direct.ts) | [setup.test.ts](../test/setup.test.ts), [model-namer.test.ts](../test/model-namer.test.ts) |
| Direct defaults, configuration, prompt loading, completion transport | [provider-registry.ts](../src/provider-registry.ts), [provider.ts](../src/provider.ts) | [provider-registry.test.ts](../test/provider-registry.test.ts), [provider.test.ts](../test/provider.test.ts) |
| Common response decoding and label validation | [model-output.ts](../src/effect/model-output.ts), [errors.ts](../src/effect/errors.ts), [domain.ts](../src/domain.ts) | [provider.test.ts](../test/provider.test.ts), [model-namer.test.ts](../test/model-namer.test.ts) |
| Pi authenticated discovery and completion | [pi.ts](../src/model-sources/pi.ts) | [pi-model-source.test.ts](../test/pi-model-source.test.ts) |
| OpenCode discovery, denied tools, cancellation, cleanup | [opencode.ts](../src/model-sources/opencode.ts) | [opencode-model-source.test.ts](../test/opencode-model-source.test.ts) |
| Real Pi and OpenCode requests through a local fake provider | Same adapters | Opt-in [harness-runtime.test.ts](../test/harness-runtime.test.ts) |

[Model sources and setup](architecture/model-sources-and-setup.md) explains adapter lifetime and credential ownership. [Contracts and boundaries](architecture/contracts-and-boundaries.md) records what may cross each interface.

## Setup and distribution

| Behavior | Source | Regression evidence |
| --- | --- | --- |
| Wizard choices, cancellation, review, validation, and startup | [setup.ts](../src/setup.ts), [setup-plan.ts](../src/setup-plan.ts) | [setup.test.ts](../test/setup.test.ts) |
| Configuration rollback and commit boundary | [setup-transaction.ts](../src/setup-transaction.ts) | [setup-transaction.test.ts](../test/setup-transaction.test.ts) |
| Direct configuration saves and prompt editor | [configure.ts](../src/configure.ts) | [configure-setup.test.ts](../test/configure-setup.test.ts), [provider.test.ts](../test/provider.test.ts) |
| Keybinding inspection without user-config edits | [setup-keybindings.ts](../src/setup-keybindings.ts) | [setup-keybindings.test.ts](../test/setup-keybindings.test.ts) |
| Herdr preflight and action-log receipts | [herdr-plugin-client.ts](../src/herdr-plugin-client.ts) | [herdr-plugin-client.test.ts](../test/herdr-plugin-client.test.ts) |
| Registered actions and runtime commands | [herdr-plugin.toml](../herdr-plugin.toml) | [manifest.test.ts](../test/manifest.test.ts), [runtime.test.ts](../test/runtime.test.ts) |
| Release-bound installer and version checks | [install.sh](../installer/install.sh), [render-installer.ts](../scripts/render-installer.ts), [check-release-version.ts](../scripts/check-release-version.ts) | [installer.test.ts](../test/installer.test.ts), [release-assets.test.ts](../test/release-assets.test.ts), [release.test.ts](../test/release.test.ts) |

## Validation tools

[CI](../.github/workflows/ci.yml) runs typecheck, lint, and tests on Linux with minimum and latest Bun, and Windows with latest Bun. [test-contained.ts](../scripts/test-contained.ts) provides macOS containment. [The lint policy](../tools/oxlint/anti-slop/UPSTREAM.md) records vendored exceptions, tested by [anti-slop-policy.test.ts](../test/anti-slop-policy.test.ts).

This map identifies relevant test files, not proof that every branch of each module is covered. Safe commands and opt-in integration modes belong in the [development guide](../docs/development.md).
