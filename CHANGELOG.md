# Changelog

## [0.6.6](https://github.com/iurysza/herdr-tab-smart-rename/compare/v0.6.5...v0.6.6) (2026-10-22)


### Bug Fixes

* accept title case labels in other cased languages ([#62](https://github.com/iurysza/herdr-tab-smart-rename/issues/62)) ([aca549a](https://github.com/iurysza/herdr-tab-smart-rename/commit/aca549a13e17b32bf3e82490a72124e0cdfb225e))

## [0.6.5](https://github.com/iurysza/herdr-tab-smart-rename/compare/v0.6.4...v0.6.5) (2026-10-20)


### Bug Fixes

* autostart the worker on server start only after setup ([#60](https://github.com/iurysza/herdr-tab-smart-rename/issues/60)) ([74fc3a5](https://github.com/iurysza/herdr-tab-smart-rename/commit/74fc3a5659632320005bfae0c4589ece9d7bf43c))

## [0.6.4](https://github.com/iurysza/herdr-tab-smart-rename/compare/v0.6.3...v0.6.4) (2026-10-15)


### Bug Fixes

* send Pi session ids only for OpenCode ([#57](https://github.com/iurysza/herdr-tab-smart-rename/issues/57)) ([b23c28c](https://github.com/iurysza/herdr-tab-smart-rename/commit/b23c28c03d6360a16d9f58600df09f5ce8b29aac))

## [0.6.3](https://github.com/iurysza/herdr-tab-smart-rename/compare/v0.6.2...v0.6.3) (2026-10-15)


### Bug Fixes

* send per-process session id with pi standalone completions ([#55](https://github.com/iurysza/herdr-tab-smart-rename/issues/55)) ([4e57c07](https://github.com/iurysza/herdr-tab-smart-rename/commit/4e57c073083f42cda01599fe65b9b470fca03c62))

## [0.6.2](https://github.com/iurysza/herdr-tab-smart-rename/compare/v0.6.1...v0.6.2) (2026-10-12)


### Bug Fixes

* reclaim numbered-default labels instead of locking manual ownership ([#45](https://github.com/iurysza/herdr-tab-smart-rename/issues/45)) ([fdbab4c](https://github.com/iurysza/herdr-tab-smart-rename/commit/fdbab4c4f9e4780471c7253a6f1e088ea1f83453))

## [0.6.1](https://github.com/iurysza/herdr-tab-smart-rename/compare/v0.6.0...v0.6.1) (2026-10-06)


### Bug Fixes

* **progress:** clear marker when Herdr trims the empty-label marker ([ac58796](https://github.com/iurysza/herdr-tab-smart-rename/commit/ac58796e950adab5ecf562a754f06e62a090aa77))
* **progress:** clear marker when Herdr trims the empty-label marker ([4d2b607](https://github.com/iurysza/herdr-tab-smart-rename/commit/4d2b60737c451048e2bdc9cc4d3b44933f61fe3a))

## [0.6.0](https://github.com/iurysza/herdr-tab-smart-rename/compare/v0.5.2...v0.6.0) (2026-09-28)


### Features

* **provider:** accept none as a reasoning effort ([#37](https://github.com/iurysza/herdr-tab-smart-rename/issues/37)) ([6fa5a7f](https://github.com/iurysza/herdr-tab-smart-rename/commit/6fa5a7fdb8e290f8bceac6a5bfe4586cc8b5cd79))


### Bug Fixes

* **rename:** name first requests promptly and mark renames in progress ([#40](https://github.com/iurysza/herdr-tab-smart-rename/issues/40)) ([8ac2a96](https://github.com/iurysza/herdr-tab-smart-rename/commit/8ac2a96fc4eedc4e998d4233a8c2ebe3b175c951))

## [0.5.2](https://github.com/iurysza/herdr-tab-smart-rename/compare/v0.5.1...v0.5.2) (2026-09-21)


### Bug Fixes

* wait for user requests before naming empty agent sessions ([#35](https://github.com/iurysza/herdr-tab-smart-rename/issues/35)) ([571be23](https://github.com/iurysza/herdr-tab-smart-rename/commit/571be23a695a203160163d93cf22002bd62fefae))

## [0.5.1](https://github.com/iurysza/herdr-tab-smart-rename/compare/v0.5.0...v0.5.1) (2026-09-19)


### Bug Fixes

* **storage:** retry Windows EPERM/EACCES on exclusive lock create ([d688bcb](https://github.com/iurysza/herdr-tab-smart-rename/commit/d688bcbabc2f604f73e18c50e7ec5a6ac83fa052))
* **storage:** retry Windows EPERM/EACCES on exclusive lock create ([0e04e8b](https://github.com/iurysza/herdr-tab-smart-rename/commit/0e04e8bf1234c9ab170fa83878b4e49de2c6376e))

## [0.5.0](https://github.com/iurysza/herdr-tab-smart-rename/compare/v0.4.0...v0.5.0) (2026-09-14)


### Features

* **domain:** support CJK and Chinese tab labels ([#18](https://github.com/iurysza/herdr-tab-smart-rename/issues/18)) ([ad3fbc9](https://github.com/iurysza/herdr-tab-smart-rename/commit/ad3fbc94d72aef008821e4ab168e69523c3e3974))
* **provider:** add DeepSeek profile ([#20](https://github.com/iurysza/herdr-tab-smart-rename/issues/20)) ([763e9bd](https://github.com/iurysza/herdr-tab-smart-rename/commit/763e9bd2c9ebdf2863edae5d25c473f7b7fa4534))

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
