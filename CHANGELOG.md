# Changelog

## [0.4.0](https://github.com/iurysza/herdr-tab-smart-rename/compare/v0.3.0...v0.4.0) (2026-09-06)


### Features

* **context:** sample Claude Code transcripts for naming ([ceba774](https://github.com/iurysza/herdr-tab-smart-rename/commit/ceba77434937f5d8b9b13f57681df3917a95d4bb))
* sample Claude Code transcripts for naming ([70ccb69](https://github.com/iurysza/herdr-tab-smart-rename/commit/70ccb692c0a0c22d35d92b1d259b95cda7387553))

## [0.3.0](https://github.com/iurysza/herdr-tab-smart-rename/compare/v0.2.0...v0.3.0) (2026-09-05)


### Features

* finish rename reliability and optional model setup ([364a5a0](https://github.com/iurysza/herdr-tab-smart-rename/commit/364a5a0fda0181261f1eb09d95d412250cdbfbaf))
* **panes:** add smart pane renaming ([b5cdeba](https://github.com/iurysza/herdr-tab-smart-rename/commit/b5cdebab6ccf7ceb1377d5a08ee6771480e08c59))
* **setup:** reuse Pi and OpenCode models with optional onboarding ([4fe26ea](https://github.com/iurysza/herdr-tab-smart-rename/commit/4fe26ea36e801a8a43187e26629f9b351ad61199))


### Bug Fixes

* **installer:** verify Herdr's requested release ref ([fc1f07d](https://github.com/iurysza/herdr-tab-smart-rename/commit/fc1f07d9dd2c74bb8254ccea2e10261a93a66cea))
* isolate rename ownership and discard stale results ([c745243](https://github.com/iurysza/herdr-tab-smart-rename/commit/c745243cd9d7f748191333a209e74bcfb21ddfef))
* **panes:** correct pane rename workflow ([45c994e](https://github.com/iurysza/herdr-tab-smart-rename/commit/45c994e29692a8da1ed771d34c545c83f24e7584))

## [0.2.0](https://github.com/iurysza/herdr-tab-smart-rename/compare/v0.1.1...v0.2.0) (2026-08-19)


### Features

* add native Windows support ([90c898f](https://github.com/iurysza/herdr-tab-smart-rename/commit/90c898f3a09c3e4e31bacf17425ffcc8e5763b15))


### Bug Fixes

* **provider:** preserve native completion token limit ([3d63521](https://github.com/iurysza/herdr-tab-smart-rename/commit/3d63521eb23318e5513cf9b529fa0e0ad2f4db4b))
* support OpenAI completion token limit ([523e50f](https://github.com/iurysza/herdr-tab-smart-rename/commit/523e50f9600682ca7101da888f7977d7eafb7f42))
* use max_completion_tokens for Luna ([a7bf8e4](https://github.com/iurysza/herdr-tab-smart-rename/commit/a7bf8e4105732629678fcc2a3203376c07cacc95))
* **windows:** connect to the named-pipe control socket and hide subprocess consoles ([d5a3a39](https://github.com/iurysza/herdr-tab-smart-rename/commit/d5a3a39fcd1bb46bb56d8b62500afabcb63bca3b))
* **windows:** stabilize native CI checks ([205a33c](https://github.com/iurysza/herdr-tab-smart-rename/commit/205a33cf13c11dff9c0ac02674de56931f4909f5))

## [0.1.1](https://github.com/iurysza/herdr-tab-smart-rename/releases/tag/v0.1.1) (2026-07-17)

### Added

- Context-aware deterministic and model-backed tab naming.
- Private provider and naming-prompt configuration actions.
- Explicit current-tab/all-tab rename and ownership reset actions.
- Rename progress feedback in tab labels and notifications.

### Fixed

- Resolve Bun from standard user and Homebrew paths when Herdr starts with a minimal `PATH`.
- Preserve manual names and serialize worker state updates safely.
