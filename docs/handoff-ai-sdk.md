# Handoff: standalone AI SDK provider

## Goal

Replace the Pi RPC model call with a standalone Vercel AI SDK provider.

Smart Rename must keep working as a Herdr plugin without launching `pi`, loading Pi extensions, or depending on Pi authentication. Keep existing naming policy, ownership state, keybindings, notifications, and session sampling.

Proceed without asking design questions. Implement the decisions below.

## Current state

Repository:

```text
/Users/iurysouza/projects/my-repos/herdr-tab-smart-rename
https://github.com/iurysza/herdr-tab-smart-rename
```

Baseline commit:

```text
c0d9924 fix: shorten rename notification copy
```

The checkout is clean. Plugin id remains `autoname`. The worker is locally linked and running. Runtime ownership state lives under:

```text
~/.local/state/herdr/plugins/autoname/
```

Do not reset or migrate that state.

## Chosen architecture

Use:

```text
ai@7.0.26
@ai-sdk/openai-compatible@3.0.9
```

Add a lockfile. Herdr GitHub installation must run `npm ci --omit=dev` through a manifest build command. Local development uses `npm install`.

Create an `AiSdkNamer` with the same `suggest(context)` responsibility as the current `PiRpc`. Replace the service field named `pi` with `namer`; remove Pi-specific model invocation code completely.

Use `createOpenAICompatible()` plus `generateText()`. Keep the existing JSON-only system prompt and `parseModelTitle()` validation. Do not require structured-output support; plain text plus existing validation is more portable across OpenAI-compatible providers.

Each request should:

- create/load the provider from current config;
- use one non-streaming `generateText()` call;
- cap output around 120 tokens;
- use low temperature;
- use an abort timeout;
- return `{ tab, reason }` through `parseModelTitle()`;
- sanitize provider errors before surfacing them;
- never log a key, request header, or raw provider response.

No persistent model process is needed. `close()` may remain as a no-op during migration if that keeps call sites simple.

## Default provider

Default to Kimi Code:

```text
provider name: kimi-code
base URL: https://api.kimi.com/coding/v1
model: kimi-for-coding
key fallback: KIMI_API_KEY
```

Kimi’s official docs confirm the OpenAI-compatible base URL and model id:

- https://www.kimi.com/code/docs/en/

Do not fake or override Kimi’s client identity/User-Agent.

The generic adapter must also support any OpenAI-compatible provider through config overrides. Reference:

- https://ai-sdk.dev/providers/openai-compatible-providers
- https://github.com/vercel/ai/tree/main/packages/openai-compatible

## Configuration contract

Use Herdr’s managed plugin config directory:

```text
HERDR_PLUGIN_CONFIG_DIR/provider.env
```

Herdr’s plugin docs require user-editable config and secrets to live under `HERDR_PLUGIN_CONFIG_DIR`, not the installed plugin root:

- https://herdr.dev/docs/plugins/

Defaults mean the user usually sets one line:

```dotenv
SMART_RENAME_API_KEY=...
```

Optional overrides:

```dotenv
SMART_RENAME_PROVIDER=kimi-code
SMART_RENAME_BASE_URL=https://api.kimi.com/coding/v1
SMART_RENAME_MODEL=kimi-for-coding
SMART_RENAME_TIMEOUT_MS=45000
```

Also accept `KIMI_API_KEY` for the default provider.

Precedence:

1. Process `SMART_RENAME_*` values.
2. `provider.env` `SMART_RENAME_*` values.
3. Process `KIMI_API_KEY`.
4. `provider.env` `KIMI_API_KEY`.
5. Non-secret defaults above.

Requirements:

- Parse a small dotenv subset locally. Do not add `dotenv`.
- Bound the file read to 16 KiB.
- Create/chmod the config directory to `0700` and `provider.env` to `0600` when Smart Rename creates them.
- Never copy, inspect, or migrate Pi credentials.
- Reload `provider.env` for every model call so edits work without restarting the worker.
- Missing-key errors must state how to configure the key without printing it.

## Herdr integration

Keep existing actions and keybindings.

Add:

```text
Smart Rename: configure AI
Smart Rename: check AI config
```

Recommended implementation:

1. Add a manifest pane entry named `provider-config`, placed as an overlay.
2. `configure-ai` opens that plugin pane through `HERDR_BIN_PATH`.
3. The pane command creates `provider.env` from a commented template when missing, enforces private permissions, then opens `$VISUAL`, `$EDITOR`, or `vi` with inherited stdio.
4. `check-ai` validates provider name, base URL, model, timeout, and key presence. It shows a short Herdr notification such as `AI ready` / `Config missing`. It must not make a billed model request.

Explicit rename actions already emit start/success/failure notifications. Missing configuration must use the existing failure toast path.

Herdr plugin context reference:

- `HERDR_PLUGIN_CONFIG_DIR`
- `HERDR_BIN_PATH`
- manifest actions and panes
- https://herdr.dev/docs/plugins/

## Files to change

Expected surface:

```text
package.json
package-lock.json
herdr-plugin.toml
src/provider.mjs          # config loading + AI SDK namer
src/configure.mjs         # private env template + editor pane
src/integrations.mjs      # remove PiRpc and Pi-only invocation env
src/service.mjs           # pi -> namer dependency name
src/cli.mjs               # instantiate namer; configure/check actions
src/worker.mjs            # instantiate namer
README.md
docs/naming-policy.md
test/provider.test.mjs
existing service/integration tests
```

Keep Pi session-file sampling in `integrations.mjs`. That context reader is independent from model invocation and remains useful for detected Pi panes. Remove only the Pi subprocess/provider coupling.

## Tests

Add coverage for:

- config defaults;
- process env over file precedence;
- `SMART_RENAME_API_KEY` over `KIMI_API_KEY`;
- missing key error;
- bounded config reads;
- private file permissions;
- successful `AiSdkNamer.suggest()` with injected generation/fetch behavior;
- invalid model JSON still rejected by `parseModelTitle()`;
- provider errors sanitized and keys absent from errors/logs;
- config reload between two calls;
- configure/check actions registered in the manifest;
- service tests use `namer`, not `pi`;
- no `spawn("pi")`, `PiRpc`, `--mode rpc`, or Kimi provider extension dependency remains.

Do not make default tests call a live provider. If a usable standalone key is present, run one opt-in live smoke test; otherwise state that live provider authentication could not be verified.

## Documentation changes

README should lead with a short setup:

```sh
herdr plugin install iurysza/herdr-tab-smart-rename
herdr plugin action invoke configure-ai --plugin autoname
herdr plugin action invoke check-ai --plugin autoname
herdr plugin action invoke start --plugin autoname
```

Explain:

- Pi is no longer required for model invocation.
- Kimi Code is the default.
- Any OpenAI-compatible endpoint can be configured.
- Secrets stay in Herdr’s private plugin config directory.
- Pi session sampling is context collection only.
- Local linking requires `npm install` because Herdr does not run build commands for linked plugins.

Remove outdated claims about Pi RPC, Pi OAuth extensions, fresh Pi processes, and zero runtime dependencies.

## Acceptance criteria

- `npm run check` passes.
- `npm test` passes.
- `npm pack --dry-run` passes.
- Manifest parses and all actions/panes register after relinking.
- Existing worker state survives.
- Current-tab and all-tab keybindings still work.
- Start/success/failure notifications still work.
- Missing key fails quickly with a useful toast.
- Config action opens the private provider file.
- Check action reports provider/model without exposing the key.
- Repository contains no Pi RPC invocation path.
- Commit and push only after tests.

## Non-goals

- Do not add a general provider marketplace.
- Do not support Anthropic-native protocol in this pass.
- Do not read Pi AuthStorage.
- Do not add OAuth.
- Do not store keys in plugin state or source.
- Do not change naming heuristics, sampling weights, ownership policy, keybindings, or notification copy.
