import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const project = path.resolve(import.meta.dir, "..");

async function lintFixture(source: string): Promise<string[]> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "smart-rename-policy-"));
  const file = path.join(directory, "fixture.ts");

  try {
    await writeFile(file, source);

    const child = Bun.spawn([
      process.execPath,
      path.join(project, "node_modules", "oxlint", "bin", "oxlint"),
      "--config", path.join(project, "oxlint.config.ts"),
      "--format", "json", file,
    ], { cwd: project, stdout: "pipe", stderr: "pipe" });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);

    assert.ok(exitCode === 0 || exitCode === 1, stderr);

    const output = z.object({ diagnostics: z.array(z.object({ code: z.string() })) }).parse(JSON.parse(stdout));

    return output.diagnostics.map((item) => item.code);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("unknown input is allowed only when consumed by a real parser", async () => {
  const good = await lintFixture(`import { z } from "zod";
    const InputSchema = z.string();
    export function parseInput(value: unknown): string {
      const parsed = InputSchema.safeParse(value);
      return parsed.success ? parsed.data : "";
    }`);

  assert.equal(good.includes("anti-slop(no-unknown-parameters)"), false);

  const rawReturn = await lintFixture(`import { z } from "zod";
    const InputSchema = z.string();
    export function leak(value: unknown): unknown {
      InputSchema.safeParse(value);
      return value;
    }`);

  assert.ok(rawReturn.includes("anti-slop(no-unknown-parameters)"));

  const fakeParser = await lintFixture(`const InputSchema = { safeParse: (value: string) => ({ data: value }) };
    export function leak(value: unknown): unknown { return InputSchema.safeParse(value).data; }`);

  assert.ok(fakeParser.includes("anti-slop(no-unknown-parameters)"));

  const identityParser = await lintFixture(`import { z } from "zod";
    const InputSchema = z.unknown();
    export function leak(value: unknown): unknown { return InputSchema.parse(value); }`);

  assert.ok(identityParser.includes("anti-slop(no-unknown-parameters)"));

  const looseParser = await lintFixture(`import { z } from "zod";
    const InputSchema = z.looseObject({});
    export function leak(value: unknown) { return InputSchema.parse(value); }`);

  assert.ok(looseParser.includes("anti-slop(no-unknown-parameters)"));

  const parsedThenLeaked = await lintFixture(`import { z } from "zod";
    const InputSchema = z.string();
    export function leak(value: unknown): string {
      InputSchema.safeParse(value);
      return String(value);
    }`);

  assert.ok(parsedThenLeaked.includes("anti-slop(no-unknown-parameters)"));

  const pretendSanitizer = await lintFixture(`import { redact } from "secret-sniff";
    import stripAnsi from "strip-ansi";
    export function sanitizeText(input: unknown): string {
      redact(stripAnsi("fixture"));
      return String(input);
    }`);

  assert.ok(pretendSanitizer.includes("anti-slop(no-unknown-parameters)"));

  const rawAfterRedaction = await lintFixture(`import { redact } from "secret-sniff";
    import stripAnsi from "strip-ansi";
    export function sanitizeText(input: unknown): string {
      let text = stripAnsi(String(input ?? ""));
      text = redact(text, {}); text = redact(text, {}); text = redact(text, {});
      text = String(input);
      return text.replace(/x/g, " ").trim();
    }`);

  assert.ok(rawAfterRedaction.includes("anti-slop(no-unknown-parameters)"));

  const unvalidatedString = await lintFixture(`export function leak(value: unknown): string { return String(value); }`);

  assert.ok(unvalidatedString.includes("anti-slop(no-unknown-parameters)"));
});

test("opaque return contract requires guarded injected action delegation", async () => {
  const good = await lintFixture(`interface DispatchOptions {
    actions?: Record<string, (options: { dryRun: boolean }) => unknown>;
  }
  export async function dispatch(command: string | undefined, { dryRun = false, actions = {} }: DispatchOptions = {}): Promise<unknown> {
    const action = command ? actions[command] : undefined;
    if (!action) throw new Error("unknown action");
    return action({ dryRun });
  }`);

  assert.equal(good.filter((code) => code === "anti-slop(no-unknown-returns)").length, 0);

  const raw = await lintFixture(`export async function dispatch(value: unknown): Promise<unknown> { return value; }`);
  assert.ok(raw.includes("anti-slop(no-unknown-returns)"));

  const unchecked = await lintFixture(`interface Unsafe { actions?: Record<string, () => unknown> };
    export function passthrough(action: () => unknown): unknown { return action(); }`);

  assert.ok(unchecked.filter((code) => code === "anti-slop(no-unknown-returns)").length >= 2);
});

test("open dictionaries require structured state or exact lossless token transform", async () => {
  const state = await lintFixture(`interface OwnershipRecord { manual?: boolean }
    type RetryRecord = { status: "failed" };
    export interface SmartRenameState {
      version: 1;
      workspaces: Record<string, OwnershipRecord>; tabs: Record<string, OwnershipRecord>; panes: Record<string, OwnershipRecord>;
      modelAttempts: Record<string, number>; namedSessions: Record<string, string[]>; retries: Record<string, RetryRecord>;
      fingerprints: Record<string, string>; pendingFingerprints: Record<string, string>; evaluations: Record<string, string>;
      [key: string]: unknown;
    }`);

  assert.equal(state.includes("anti-slop(no-unsafe-dictionary-type)"), false);

  const transform = await lintFixture(`export function transformOpenAiRequestBody(body: Record<string, unknown>): Record<string, unknown> {
    const { max_tokens, ...rest } = body;
    return max_tokens == null ? rest : { ...rest, max_completion_tokens: max_tokens };
  }`);

  assert.equal(transform.includes("anti-slop(no-unsafe-dictionary-type)"), false);

  const passthrough = await lintFixture(`export function transformOpenAiRequestBody(body: Record<string, unknown>): Record<string, unknown> {
    return body;
  }`);

  assert.ok(passthrough.filter((code) => code === "anti-slop(no-unsafe-dictionary-type)").length >= 2);

  const unowned = await lintFixture(`export interface SmartRenameState { version: 1; [key: string]: unknown }`);
  assert.ok(unowned.includes("anti-slop(no-unsafe-dictionary-type)"));

  const anyValue = await lintFixture(`export function transformOpenAiRequestBody(body: Record<string, any>): Record<string, any> {
    const { max_tokens, ...rest } = body;
    return max_tokens == null ? rest : { ...rest, max_completion_tokens: max_tokens };
  }`);

  assert.ok(anyValue.includes("anti-slop(no-unsafe-dictionary-type)"));
});
