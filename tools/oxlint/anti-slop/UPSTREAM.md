# anti-slop provenance

Vendored Oxlint rules from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop).

- Source repository: https://github.com/dmmulroy/anti-slop
- Source commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (2026-09-10)
- Copied via the bundled `install-anti-slop` skill (`scripts/install.mjs`), which
  vendors `skills/install-anti-slop/assets/anti-slop/` (production rule sources
  without their RuleTester suites).
- Installed plugin entry points:
  - `tools/oxlint/anti-slop/index.ts` (generic rules)
  - `tools/oxlint/anti-slop/effect/index.ts` (opt-in Effect rules)
- Oxlint dependencies pinned exactly in `package.json`: `oxlint` and
  `@oxlint/plugins` at `1.83.0`.

## Intentional deviations

- None yet. This is a pristine copy of the upstream commit above. Edit these
  files in place to adjust policy for this repository; record deviations here.

The `require-readable-spacing` rule vendors comment-aware logic from ESLint
Stylistic under MIT; its license and provenance live in
`vendor/eslint-stylistic/` and must travel with the code.
