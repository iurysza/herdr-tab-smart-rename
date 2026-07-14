# Handoff: simplify Smart Rename

## Goal

Make Smart Rename smaller in concepts, clearer at its boundaries, and easier to understand without changing behavior.

This is a tiny Herdr plugin. Its architecture should communicate the whole product quickly:

1. collect bounded task context;
2. choose a deterministic name or ask a `Namer`;
3. preserve manual ownership;
4. write the rename safely;
5. repeat on events and sweeps.

Do the work directly. Do not use subagents. Do not ask design questions. Inspect first, choose the smallest coherent refactor, implement it, tighten the README, validate end to end, then commit and push.

## Baseline

Repository:

```text
/Users/iurysouza/projects/my-repos/herdr-tab-smart-rename
https://github.com/iurysza/herdr-tab-smart-rename
```

Baseline commit:

```text
5b0c98d feat: use standalone AI SDK provider
```

The standalone provider migration is complete and pushed.

Current runtime:

- plugin id: `autoname`;
- locally linked from this checkout;
- worker running from `src/worker.mjs`;
- ownership state preserved under `~/.local/state/herdr/plugins/autoname/`;
- private config at `HERDR_PLUGIN_CONFIG_DIR/provider.env`;
- `provider.env` exists with mode `0600` and currently has no key;
- config directory mode is `0700`;
- no live provider smoke test was run because no standalone key exists.

Do not reset, migrate, or delete runtime ownership state.

## Behavior to preserve exactly

Do not change:

- naming heuristics or title rules;
- dominant-pane priority;
- weighted Pi session sampling;
- 4,500-character context cap;
- manual ownership semantics;
- state schema/version;
- state locking and race guarantees;
- event subscriptions or 60-second sweep;
- model cooldown and fingerprint behavior;
- explicit-action force/reclaim behavior;
- action ids, pane id, plugin id, or keybindings;
- notification copy or sounds;
- Kimi Code defaults;
- generic OpenAI-compatible overrides;
- `provider.env` names, precedence, permissions, or per-call reload;
- missing-key behavior;
- provider timeout/output/temperature behavior;
- provider error redaction;
- Herdr GitHub build command;
- worker lifecycle behavior.

Pi session files remain an optional context source for detected Pi panes. Pi must never be launched or used for model authentication.

## Current friction

The implementation works, but several boundaries are muddy:

1. `src/cli.mjs` and `src/worker.mjs` duplicate namer/service composition.
2. `src/integrations.mjs` combines Herdr commands, process inspection, Pi session sampling, and socket event framing.
3. `src/core.mjs` combines domain policy, ownership transitions, sanitization, model-context shaping, and churn gates.
4. Important data contracts are implicit object shapes.
5. `src/cli.mjs` executes at module load, making action-level tests awkward.
6. `src/provider.mjs` exposes many helper functions because tests target implementation details.
7. `test/provider.test.mjs` is comprehensive but repetitive and coupled to source layout.
8. The README is accurate but longer and more repetitive than this tool needs.

These are observations, not instructions to create more layers. A split is useful only when it makes ownership obvious and reduces coupling.

## Design standard

Prefer a handful of sharp boundaries over many files or generic abstractions.

The code should make these contracts explicit. Use concise JSDoc typedefs near their owner if Node.js remains, or real TypeScript types if the Bun spike wins:

```text
Namer.suggest(NamingContext) -> Promise<NameSuggestion>
ProviderConfig
NamingContext
NameSuggestion
RenameResult
OwnershipRecord
SmartRenameState
ServiceDependencies
```

Do not add a schema library. Do not create interfaces, factories, repositories, or dependency-injection machinery unless they remove more complexity than they add. TypeScript is useful only if it runs directly with a chosen runtime and does not introduce a compile/distribution layer.

A good target shape has these responsibilities, whether or not each becomes a file:

```text
pure naming domain
  labels, heuristics, ownership transitions, gates, context limits

context collection
  Herdr pane process/output + bounded Pi session sampling

provider
  private config resolution + one Namer implementation

service
  one orchestration path for initialize/evaluate/evaluate-all

entrypoints
  CLI actions, configure pane, worker event loop
```

Herdr transport and session-file parsing should not look like one conceptual dependency just because they currently share `integrations.mjs`.

## Concrete simplification opportunities

Evaluate these in order. Keep only changes that clearly improve the code.

1. Add one composition function used by both CLI and worker. Remove duplicated `AiSdkNamer` / `AutoNameService` construction.
2. Remove the no-op `AiSdkNamer.close()` and matching `try/finally` blocks unless a real resource lifecycle remains.
3. Make CLI dispatch callable as a function, with the executable guard at the bottom. Test actions through that boundary instead of source-string assertions where practical.
4. Give the Namer, config, context, state, and result objects named JSDoc contracts.
5. Separate Herdr IO from Pi session-file sampling if the resulting modules each have one obvious purpose.
6. Narrow module exports. Test public behavior; keep parser/config internals private unless they are real contracts.
7. Consolidate table-shaped config precedence tests and remove repetitive fixtures without losing cases.
8. Keep transaction/race behavior intact. Do not shorten the locking code by reintroducing stale-snapshot races.
9. Rename vague modules only if the new name communicates ownership better and import churn is justified.
10. Measure the result by fewer concepts, smaller public surfaces, less duplicated composition, and a shorter code tour—not raw line deletion.

## Architecture guardrails

- No framework.
- No general provider marketplace.
- No TypeScript build pipeline.
- No Zod or dotenv dependency.
- Bun is allowed only when it produces a demonstrated simplification; see below.
- No classes beyond the service/namer if plain functions are clearer.
- No speculative extension points.
- No backwards-compatibility adapters for internal names.
- No changes to runtime paths or state.
- No shelling out to Pi.
- No key inspection outside Smart Rename's standalone env/config contract.
- No live provider request unless a standalone key is already present.

## Bun decision

A Bun rewrite is permitted, not required.

Start with a short comparison between:

1. Node.js + focused JSDoc contracts.
2. Bun + directly executed TypeScript contracts.

Node.js is the lower-risk default because Herdr GitHub installation can rely on the runtime already declared by the plugin. Bun can still win if direct TypeScript and its built-in APIs make the complete install/runtime/test story materially simpler.

Choose Bun only if the comparison proves a concrete improvement such as:

- fewer runtime concepts or dependencies;
- materially simpler process/file/config code;
- a reliable self-contained artifact or simpler Herdr install path;
- simpler tests without losing coverage;
- real TypeScript contracts without a compile step.

Do not switch for startup speed, novelty, or a small line-count reduction. This worker is IO-bound and long-lived; runtime speed is not the problem.

If choosing Bun:

- use Bun + TypeScript consistently, not Node/Bun compatibility branches;
- confirm Vercel AI SDK v7 and the provider work under the pinned Bun version;
- replace the lock/build/test commands coherently;
- ensure GitHub-installed Herdr plugins can obtain/run Bun without undocumented machine assumptions;
- update `herdr-plugin.toml`, requirements, local-link instructions, CI/check commands, and pack/distribution validation;
- rerun the same end-to-end Herdr matrix;
- state the measured simplification in the commit/report.

If those conditions are not clearly met, keep Node.js + JSDoc. Record the choice and one-sentence reason in the final report; no ADR is needed for this tool.

## README pass

Do this after the code is stable.

The README should be result-first and short:

1. what it does, with 2–3 label examples;
2. install/configure/check/start in one block;
3. keybindings and actions;
4. naming/ownership rules;
5. provider config and privacy;
6. development and troubleshooting.

Remove repeated explanations. Link to `docs/naming-policy.md` for detailed behavior. Keep the banner. Keep exact commands and facts. State clearly:

- Kimi Code is the default;
- any OpenAI-compatible endpoint can be used;
- Pi is optional context collection only;
- secrets live in Herdr's private plugin config directory;
- local links require `npm install`;
- explicit rename actions reclaim manual tabs;
- no standalone key means no model-backed rename.

## Tests

Preserve every behavioral guarantee from the current 40-test baseline.

Tests must still cover:

- naming validation, sanitization, ownership, heuristics, context cap, and model gates;
- dominant-pane priority;
- weighted/bounded Pi session sampling;
- serialized state and stale-snapshot race regression;
- forced/manual/dry-run behavior;
- provider defaults and precedence;
- private config permissions and 16 KiB bound;
- per-request config reload;
- one AI SDK request with timeout/output limits;
- invalid model output rejection;
- provider error/key redaction;
- manifest actions, pane, and build entry;
- absence of Pi model invocation coupling;
- singleton worker safety.

Fewer, table-driven tests are welcome. Reduced coverage is not.

## End-to-end validation

Run in this order:

```sh
npm ci --omit=dev
npm run check
npm test
npm pack --dry-run
```

Then validate Herdr:

1. Confirm `HERDR_ENV=1` before controlling Herdr.
2. Record worker PID/script and state record counts.
3. Stop the verified worker.
4. Relink this checkout.
5. Reload Herdr config.
6. Confirm all actions register:
   - `start`
   - `stop`
   - `status`
   - `configure-ai`
   - `check-ai`
   - `rename-now`
   - `rename-all`
   - `reset-tab`
   - `reset-workspace`
7. Confirm pane `provider-config` registers as an overlay.
8. Start the worker and verify the exact absolute worker script.
9. Confirm ownership state still has the same schema and records.
10. Open `configure-ai`, verify it shows `provider.env`, then close only that overlay.
11. Verify config directory/file modes remain `0700`/`0600`.
12. Run `check-ai`; without a key it must fail quickly and emit `Config missing` without a billed request.
13. Confirm both keybindings still point to `autoname.rename-now` and `autoname.rename-all`.
14. Confirm explicit rename notification copy remains unchanged in source.

If a standalone `SMART_RENAME_API_KEY` or `KIMI_API_KEY` already exists in process env or `provider.env`, run one opt-in live provider smoke test on a disposable tab. Otherwise state that live authentication was not tested. Never inspect Pi credentials.

Clean up any overlay or disposable tab created during validation. Leave the worker running.

## Acceptance criteria

- Architecture reads cleanly in a short code tour.
- Core contracts have useful JSDoc names.
- CLI and worker share one composition path.
- No dead lifecycle methods or redundant model wrappers remain.
- Mixed integrations are separated only where that clarifies ownership.
- Public exports and tests are tighter.
- README is shorter and more direct.
- Naming behavior and runtime state are unchanged.
- Full checks, tests, pack, and Herdr validation pass.
- Live model smoke runs only with a standalone key.
- Worker ends healthy and linked to this checkout.
- Commit and push the simplification.
