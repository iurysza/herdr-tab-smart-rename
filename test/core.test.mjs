import test from "node:test";
import assert from "node:assert/strict";
import {
  acknowledgeRename,
  buildModelContext,
  emptyState,
  heuristicTitle,
  isDefaultLabel,
  markModelAttempt,
  markModelSuccess,
  parseModelTitle,
  prepareRename,
  reconcileItem,
  resetOwnership,
  sanitize,
  shouldCallModel,
  validateTabLabel,
  workspaceCandidate,
  MAX_CONTEXT_CHARS,
  MODEL_RATE_MS,
} from "../src/core.mjs";

test("default labels are eligible while meaningful labels lock", () => {
  assert.equal(reconcileItem(undefined, "3", true).manual, false);
  assert.equal(reconcileItem(undefined, "My Manual Task", false).manual, true);
  assert.equal(isDefaultLabel("12", 12), true);
  assert.equal(isDefaultLabel("Build API", 12), false);
});

test("startup mismatch locks while matching labels acknowledge ownership", () => {
  assert.deepEqual(
    reconcileItem({ expectedLabel: "Build API", manual: false }, "Other"),
    { manual: true, observedLabel: "Other" },
  );
  assert.equal(
    reconcileItem({ autoLabel: "Build API", manual: false }, "Manual Name").manual,
    true,
  );
  assert.deepEqual(
    reconcileItem({ expectedLabel: "Build API" }, "Build API"),
    { autoLabel: "Build API", manual: false, observedLabel: "Build API" },
  );
});

test("rename acknowledgement and reset preserve manual ownership semantics", () => {
  const prepared = prepareRename({}, "Fix Socket Reconnect");
  assert.deepEqual(acknowledgeRename(prepared, "Fix Socket Reconnect"), {
    autoLabel: "Fix Socket Reconnect",
    manual: false,
    observedLabel: "Fix Socket Reconnect",
  });
  assert.equal(acknowledgeRename(prepared, "My Name").manual, true);
  assert.equal(
    acknowledgeRename(
      { autoLabel: "Fix Socket Reconnect", manual: false },
      "Fix Socket Reconnect",
    ).manual,
    false,
  );
  const reset = resetOwnership({
    manual: true,
    autoLabel: "Old",
    expectedLabel: "Next",
  });
  assert.equal(reset.manual, false);
  assert.equal(reset.autoLabel, undefined);
  assert.equal(reset.expectedLabel, undefined);
});

test("tab labels require bounded Title Case words", () => {
  assert.equal(validateTabLabel("Fix Socket Reconnect"), true);
  assert.equal(validateTabLabel("Optimize VAR for Explainers"), true);
  assert.equal(validateTabLabel("fix socket"), false);
  assert.equal(validateTabLabel("One"), false);
  assert.equal(validateTabLabel("This Label Has Far Too Many Words"), false);
  assert.equal(validateTabLabel("Fix\nSocket"), false);
  assert.throws(() =>
    parseModelTitle('{"tab":"agent · Fix Socket","reason":"x"}'),
  );
  assert.equal(
    parseModelTitle(
      '```json\n{"tab":"Fix Socket","reason":"clear"}\n```',
    ).tab,
    "Fix Socket",
  );
});

test("workspace identity stays on meaningful workspace label", () => {
  assert.equal(
    workspaceCandidate(
      { label: "var", number: 1 },
      { cwd: "/code/other-project" },
      "/code/other-project",
    ),
    "VAR",
  );
  assert.equal(
    workspaceCandidate(
      { label: "1", number: 1, worktree: { repo_name: "herdr-autoname" } },
      {},
      null,
    ),
    "Herdr Autoname",
  );
});

test("ordinary process heuristics avoid model calls", () => {
  assert.equal(
    heuristicTitle({ focusedPane: { process: { command: "npm run dev" } } }),
    "Dev Server",
  );
  assert.equal(
    heuristicTitle({ focusedPane: { process: { command: "pytest -q" } } }),
    "Run Tests",
  );
  assert.equal(
    heuristicTitle({ focusedPane: { process: { command: "zsh" } } }),
    null,
  );
});

test("model context is hard bounded and excludes current auto labels", () => {
  const huge = "x".repeat(20_000);
  const context = buildModelContext({
    workspaceName: huge,
    paneContexts: [
      {
        focused: true,
        process: { name: huge, command: huge, cwd: huge },
        recentOutput: huge,
        userMessages: Array.from({ length: 10 }, () => huge),
      },
    ],
  });
  assert.ok(JSON.stringify(context).length <= MAX_CONTEXT_CHARS);
  assert.equal("currentTab" in context, false);
  assert.equal("currentWorkspace" in context, false);
});

test("sanitizer redacts common credential shapes", () => {
  const input = [
    "Authorization: Bearer abc.def.ghi",
    'OPENAI_API_KEY="sk-abcdefghijklmnop"',
    "AWS_SECRET_ACCESS_KEY=verysecret",
    "https://user:password@example.com/path",
    "github_pat_abcdefghijklmnop",
  ].join(" ");
  const output = sanitize(input, "");
  assert.doesNotMatch(output, /abc\.def|verysecret|password@example|abcdefghijklmnop/);
  assert.match(output, /redacted/i);
});

test("failed attempts back off while successful fingerprints stay suppressed", () => {
  const state = emptyState();
  const context = { task: "x" };
  assert.equal(shouldCallModel(state, "t1", context, 1_000_000).allowed, true);
  markModelAttempt(state, "t1", 1_000_000);
  assert.equal(shouldCallModel(state, "t1", context, 1_000_001).allowed, false);
  assert.equal(
    shouldCallModel(
      state,
      "t1",
      context,
      1_000_000 + MODEL_RATE_MS + 1,
    ).allowed,
    true,
  );

  markModelSuccess(state, "t1", context);
  assert.equal(
    shouldCallModel(
      state,
      "t1",
      context,
      1_000_000 + MODEL_RATE_MS * 2,
    ).allowed,
    false,
  );
  assert.equal(
    shouldCallModel(state, "t1", { task: "changed" }, 1_000_001).allowed,
    false,
  );
  assert.equal(
    shouldCallModel(
      state,
      "t1",
      { task: "changed" },
      1_000_000 + MODEL_RATE_MS + 1,
    ).allowed,
    true,
  );
});
