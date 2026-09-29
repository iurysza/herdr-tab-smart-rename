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
- Current Oxlint dependencies pinned exactly in `package.json`: `oxlint` and
  `@oxlint/plugins` at `1.85.0` (the vendored source remains from the commit above).

## Intentional deviations

- `no-unknown-parameters`: permit an `unknown` input only when every use in the
  function body goes directly to a real local Zod schema parser, Zod `Error`
  parser, or an evidenced domain coercion (`isDefaultLabel`, `titleCase`,
  `sanitizeText`, `boundedText`, `fingerprint`). Schema evidence requires a
  local Zod declaration with a concrete parser, not `z.unknown()`, `z.any()`
  or an unbounded loose object. The sanitizer evidence includes its library
  imports and actual transformation flow with only one use of the raw input;
  raw returns, fake named schemas, post-redaction raw reuse, cosmetic sanitizer
  calls and unvalidated stringification still fail. This preserves intentionally untrusted public
  inputs, error rendering, and context hashing.
- `no-unknown-returns`: permit only the typed injected CLI action callback and
  `dispatch`'s guarded delegation of that callback's opaque result. Raw unknown
  returns and unrelated callbacks still fail. Herdr JSON transport helpers now
  parse with their caller-provided schemas instead of returning unknown.
- `no-unsafe-dictionary-type`: permit the fully typed, forward-compatible
  `SmartRenameState` with its additional state keys and the exact lossless
  OpenAI token-body transform that retains arbitrary SDK fields. An unowned
  dictionary, a raw-body passthrough, and an `any` value dictionary still fail.

`test/anti-slop-policy.test.ts` runs Oxlint on isolated positive and negative
fixtures for all three exceptions. Run `bun test test/anti-slop-policy.test.ts`
and the normal `bun run lint`; no rule severity or CI configuration changed.

The `require-readable-spacing` rule vendors comment-aware logic from ESLint
Stylistic under MIT; its license and provenance live in
`vendor/eslint-stylistic/` and must travel with the code.
