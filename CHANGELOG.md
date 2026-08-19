# Changelog

## [0.2.0](https://github.com/iurysza/herdr-tab-smart-rename/compare/v0.1.1...v0.2.0) (2026-08-19)


### Features

* add native Windows support ([90c898f](https://github.com/iurysza/herdr-tab-smart-rename/commit/90c898f3a09c3e4e31bacf17425ffcc8e5763b15))


### Bug Fixes

* **provider:** preserve native completion token limit ([3d63521](https://github.com/iurysza/herdr-tab-smart-rename/commit/3d63521eb23318e5513cf9b529fa0e0ad2f4db4b))
* support OpenAI completion token limit ([523e50f](https://github.com/iurysza/herdr-tab-smart-rename/commit/523e50f9600682ca7101da888f7977d7eafb7f42))
* use max_completion_tokens for Luna ([a7bf8e4](https://github.com/iurysza/herdr-tab-smart-rename/commit/a7bf8e4105732629678fcc2a3203376c07cacc95))
* **windows:** connect to the named-pipe control socket and hide subprocess consoles ([abf50d0](https://github.com/iurysza/herdr-tab-smart-rename/commit/abf50d0cfdc00b6725fcad1a4c09bcfa78944ddc))
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
