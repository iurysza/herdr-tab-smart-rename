# Dependabot Q2 policy

## Decision

Dependabot opens dependency-update pull requests. Maintainers review and merge them. No workflow auto-merges an update.

## Scope

- Bun dependencies: weekly. Dependabot groups patch and minor updates. It opens major updates separately.
- GitHub Actions: monthly. Dependabot groups patch and minor updates. It opens major updates separately.
- Dependabot limits each ecosystem to three open pull requests.

## Review

Every update pull request runs the normal CI checks. Review the upstream release notes and the dependency diff before merging. Keep Bun, AI, Effect, Pi, OpenCode, and Herdr-related updates manual.

## Revisit

Reconsider narrow patch auto-merge only after lint is a required green check and CI includes reliable live Herdr plus Pi or OpenCode smoke coverage.
