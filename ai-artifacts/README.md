# Smart Rename knowledge base

Start with the [architecture overview](ARCHITECTURE.md) to see the running processes, data, and external systems. The [naming glossary](CONTEXT.md) defines the terms used throughout this knowledge base.

## Find an explanation

| What you need to understand | Read |
| --- | --- |
| How the worker, CLI, service, and model sources fit together | [Architecture overview](ARCHITECTURE.md) |
| Why a tab uses one pane's task, and when a model is called | [Naming flow](architecture/naming-flow.md) |
| How manual labels survive events, concurrent requests, and late results | [Ownership and concurrency](architecture/ownership-and-concurrency.md) |
| How Direct, Pi, and OpenCode differ, and when setup saves configuration | [Model sources and setup](architecture/model-sources-and-setup.md) |
| What crosses a trust boundary, which types carry it, and what happens on failure | [Contracts and boundaries](architecture/contracts-and-boundaries.md) |
| Which source file or test to change | [Code and test map](SEMANTIC_MAP.md) |

For a first read, follow the overview, naming flow, then ownership and concurrency. Use the glossary and contract reference for lookup.

## Product and contributor guides

The [project README](../README.md) explains installation and everyday use. [Configuration and controls](../docs/configuration.md) owns action names, settings, and troubleshooting. [Development](../docs/development.md) owns safe test commands. The [naming policy](../docs/naming-policy.md) is the default model prompt, so editing it changes runtime behavior.

These architecture pages explain the implementation rather than repeat those guides. Source and test links identify the evidence for each flow. The diagrams describe existing behavior, not a proposed redesign.

## Historical records

Goal logs and plans describe their own checkpoints. Their test counts, deployment instructions, and remaining tasks are not current operational instructions.

- [Rename reliability log](goals/rename-reliability/dev-log.md) records the ownership and stale-result repair
- [Setup and model-source integration log](goals/stable-onboarding-integration/dev-log.md) records optional model sources, rollback, and worker readiness
- [Claude Code transcript goal](goals/claude-code-transcripts/goal.md) records the bounded transcript integration

Use [release documentation](../docs/releasing.md) and the [changelog](../CHANGELOG.md) for release history and procedures.
