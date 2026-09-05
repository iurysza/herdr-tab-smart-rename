#!/usr/bin/env bun
import { createRequire } from "node:module";
import {
  saveDirectProviderConfig,
  validateDirectSetupConfig,
  type DirectSetupConfig,
} from "./configure.ts";
import { checkAi } from "./cli.ts";
import { loadProviderConfig } from "./provider.ts";
import {
  loadModelSelection,
  resolvePluginConfigDirectory,
  saveModelSelection,
} from "./model-selection.ts";
import type {
  ModelSelection,
  ModelSource,
  ModelSourceId,
} from "./model-source.ts";
import { loadModelSource } from "./model-sources/index.ts";
import { HerdrPluginClient } from "./herdr-plugin-client.ts";
import { inspectKeybindings, type KeybindingInspection } from "./setup-keybindings.ts";
import { setupReview } from "./setup-plan.ts";
import { beginSetupTransaction, type SetupTransaction } from "./setup-transaction.ts";

interface Choice {
  value: string;
  label: string;
  hint?: string;
}

interface Spinner {
  start(message?: string): void;
  stop(message?: string): void;
  error(message?: string): void;
}

export interface SetupPrompts {
  select(options: { message: string; options: Choice[]; initialValue?: string }): Promise<unknown>;
  autocomplete(options: { message: string; options: Choice[]; placeholder?: string }): Promise<unknown>;
  text(options: { message: string; placeholder?: string; defaultValue?: string }): Promise<unknown>;
  password(options: { message: string }): Promise<unknown>;
  confirm(options: { message: string; initialValue?: boolean }): Promise<unknown>;
  spinner(): Spinner;
  isCancel(value: unknown): boolean;
  summary(message: string): void;
  cancel(message: string): void;
  success(message: string): void;
}

const SETUP_CANCELLED = Symbol("setup-cancelled");
const require = createRequire(import.meta.url);

async function defaultPrompts(): Promise<SetupPrompts> {
  patchBunStyleText();
  const clack = await import("@clack/prompts");
  return {
    select: clack.select,
    autocomplete: clack.autocomplete,
    text: clack.text,
    password: maskedPassword,
    confirm: clack.confirm,
    spinner: clack.spinner,
    isCancel: (value) => value === SETUP_CANCELLED || clack.isCancel(value),
    summary: (message) => clack.note(message, "Smart Rename setup"),
    cancel: clack.cancel,
    success: clack.outro,
  };
}

function patchBunStyleText(): void {
  if (!process.versions.bun) return;
  const util = require("node:util") as { styleText: (format: string | readonly string[], text: string) => string };
  const original = util.styleText;
  if ((original as { __smartRenamePatched?: boolean }).__smartRenamePatched) return;
  const compatible = (format: string | readonly string[], text: string): string =>
    (Array.isArray(format) ? format : [format]).reduce((styled, item) => original(item, styled), text);
  (compatible as { __smartRenamePatched?: boolean }).__smartRenamePatched = true;
  util.styleText = compatible;
}

interface CollectedChoice {
  readonly selection: ModelSelection;
  readonly direct?: DirectSetupConfig;
}

export interface SetupDependencies {
  prompts?: SetupPrompts;
  sourceFactory?: (selection: ModelSelection, env: NodeJS.ProcessEnv) => Promise<ModelSource>;
  resolveConfigDirectory?: (env: NodeJS.ProcessEnv) => Promise<string>;
  probeExisting?: (env: NodeJS.ProcessEnv, directory: string) => Promise<ModelSelection | undefined>;
  saveSelection?: (directory: string, selection: ModelSelection) => Promise<void>;
  saveDirect?: (config: DirectSetupConfig, env: NodeJS.ProcessEnv) => Promise<void>;
  inspectKeybindings?: (requested: readonly ("rename-now" | "rename-all")[], env: NodeJS.ProcessEnv) => Promise<KeybindingInspection>;
  beginTransaction?: (directory: string, options: { includesDirect: boolean }) => Promise<SetupTransaction>;
  validate?: (env: NodeJS.ProcessEnv) => Promise<string>;
  startWorker?: (env: NodeJS.ProcessEnv) => Promise<void>;
}

export interface SetupResult {
  saved: boolean;
  selection?: ModelSelection;
}

export async function runSetup(
  env: NodeJS.ProcessEnv = process.env,
  {
    prompts: injectedPrompts,
    sourceFactory = loadModelSource,
    resolveConfigDirectory = resolvePluginConfigDirectory,
    probeExisting = defaultProbeExisting,
    saveSelection = saveModelSelection,
    saveDirect = saveDirectProviderConfig,
    inspectKeybindings: inspect = inspectKeybindings,
    beginTransaction = (directory, options) => beginSetupTransaction(directory, options),
    validate = (setupEnv) => checkAi(setupEnv, { notify: async () => {}, report: () => {} }),
    startWorker = async (setupEnv) => new HerdrPluginClient({ env: setupEnv }).invokeAndWait("start"),
  }: SetupDependencies = {},
): Promise<SetupResult> {
  const prompts = injectedPrompts ?? (await defaultPrompts());
  const configDirectory = await resolveConfigDirectory(env);
  const setupEnv = { ...env, HERDR_PLUGIN_CONFIG_DIR: configDirectory };
  const existing = await probeExisting(setupEnv, configDirectory);

  let choice: CollectedChoice | undefined;
  let action: "keep" | "replace";
  if (existing) {
    const keep = await answer<boolean>(prompts, prompts.confirm({
      message: `Keep existing AI setup (${existing.source} ${existing.provider}/${existing.model})?`,
      initialValue: true,
    }));
    if (keep === undefined) return cancelled(prompts);
    if (keep) {
      choice = { selection: existing };
      action = "keep";
    } else {
      choice = await collectChoice(prompts, setupEnv, sourceFactory);
      if (!choice) return cancelled(prompts);
      action = "replace";
    }
  } else {
    choice = await collectChoice(prompts, setupEnv, sourceFactory);
    if (!choice) return cancelled(prompts);
    action = "replace";
  }

  const requested = await collectKeybindingChoices(prompts);
  if (!requested) return cancelled(prompts);
  const keybindings = await inspect(requested, setupEnv);
  prompts.summary(setupReview({ selection: choice.selection, action, keybindings }));
  const confirmed = await answer<boolean>(prompts, prompts.confirm({ message: "Apply this setup?", initialValue: true }));
  if (confirmed !== true) return cancelled(prompts);

  let transaction: SetupTransaction | undefined;
  try {
    if (action === "replace") {
      transaction = await beginTransaction(configDirectory, { includesDirect: choice.direct !== undefined });
      if (choice.direct) await saveDirect(choice.direct, setupEnv);
      await saveSelection(configDirectory, choice.selection);
    }
    await validate(setupEnv);
  } catch (error) {
    await rollbackOrThrow(transaction, error);
    throw error;
  }
  transaction?.commit();

  try {
    await startWorker(setupEnv);
  } catch (error) {
    throw new Error(`AI configuration is valid but Smart Rename could not start. ${errorMessage(error)}\nRetry: herdr plugin action invoke start --plugin tab-smart-rename`);
  }
  prompts.success("Smart Rename is ready");
  return { saved: action === "replace", selection: choice.selection };
}

async function defaultProbeExisting(
  env: NodeJS.ProcessEnv,
  directory: string,
): Promise<ModelSelection | undefined> {
  try {
    await checkAi(env, { notify: async () => {}, report: () => {} });
    const selection = await loadModelSelection(directory, env);
    if (selection.source !== "direct") return selection;
    const config = await loadProviderConfig(env);
    return { version: 1, source: "direct", provider: config.provider, model: config.model, ...(config.reasoningEffort ? { profile: config.reasoningEffort } : {}) };
  } catch {
    return undefined;
  }
}

async function rollbackOrThrow(transaction: SetupTransaction | undefined, cause: unknown): Promise<void> {
  if (!transaction) return;
  try {
    await transaction.rollback();
  } catch (rollback) {
    throw new Error(`${errorMessage(cause)}; ${errorMessage(rollback)}`);
  }
}

async function collectKeybindingChoices(prompts: SetupPrompts): Promise<("rename-now" | "rename-all")[] | undefined> {
  const current = await answer<boolean>(prompts, prompts.confirm({
    message: "Show current-tab rename keybinding instructions?",
    initialValue: false,
  }));
  if (current === undefined) return undefined;
  const all = await answer<boolean>(prompts, prompts.confirm({
    message: "Show all-tabs rename keybinding instructions?",
    initialValue: false,
  }));
  if (all === undefined) return undefined;
  return [ ...(current ? ["rename-now" as const] : []), ...(all ? ["rename-all" as const] : []) ];
}

async function collectChoice(
  prompts: SetupPrompts,
  env: NodeJS.ProcessEnv,
  sourceFactory: NonNullable<SetupDependencies["sourceFactory"]>,
): Promise<CollectedChoice | undefined> {
  const source = await answer<ModelSourceId>(prompts, prompts.select({
    message: "Model source",
    options: [
      { value: "pi", label: "Pi", hint: "Use Pi's connected providers" },
      { value: "opencode", label: "OpenCode", hint: "Use OpenCode's connected providers" },
      { value: "direct", label: "Direct", hint: "Use a private OpenAI-compatible key" },
    ],
  }));
  if (!source) return undefined;
  if (source === "direct") {
    const direct = await collectDirectConfig(prompts);
    if (!direct) return undefined;
    return { direct, selection: { version: 1, source, provider: direct.provider, model: direct.model, ...(direct.reasoningEffort ? { profile: direct.reasoningEffort } : {}) } };
  }
  const adapter = await sourceFactory({ version: 1, source, provider: source, model: source }, env);
  try {
    const spinner = prompts.spinner();
    spinner.start(`Discovering connected ${source} providers`);
    const providers = await adapter.listProviders().catch((error: unknown) => {
      spinner.error(`Could not discover ${source} providers`);
      throw error;
    });
    spinner.stop("Connected providers found");
    if (!providers.length) throw new Error(`No connected ${source} providers. Sign in, then run setup.`);
    const provider = await answer<string>(prompts, prompts.autocomplete({ message: "Provider", options: providers.map((item) => ({ value: item.id, label: item.label })), placeholder: "Search providers" }));
    if (!provider) return undefined;
    const models = await adapter.listModels(provider);
    if (!models.length) throw new Error("No models are available for this provider.");
    const model = await answer<string>(prompts, prompts.autocomplete({ message: "Model", options: models.map((item) => ({ value: item.id, label: item.label })), placeholder: "Search models" }));
    if (!model) return undefined;
    const profiles = await adapter.listProfiles(provider, model);
    const profile = profiles.length ? await answer<string>(prompts, prompts.autocomplete({ message: source === "pi" ? "Thinking level" : "Variant", options: profiles.map((item) => ({ value: item.id, label: item.label })), placeholder: source === "pi" ? "Search thinking levels" : "Search variants" })) : undefined;
    if (profiles.length && !profile) return undefined;
    return { selection: { version: 1, source, provider, model, ...(profile ? { profile } : {}) } };
  } finally {
    await adapter.close?.();
  }
}

async function collectDirectConfig(prompts: SetupPrompts): Promise<DirectSetupConfig | undefined> {
  const provider = await answer<string>(prompts, prompts.text({ message: "Provider", defaultValue: "openai" }));
  if (provider === undefined) return undefined;
  const baseURL = await answer<string>(prompts, prompts.text({ message: "Base URL", defaultValue: "https://api.openai.com/v1" }));
  if (baseURL === undefined) return undefined;
  const model = await answer<string>(prompts, prompts.text({ message: "Model", defaultValue: "gpt-5.6-luna" }));
  if (model === undefined) return undefined;
  const apiKey = await answer<string>(prompts, prompts.password({ message: "API key" }));
  if (apiKey === undefined) return undefined;
  const reasoning = await answer<string>(prompts, prompts.select({ message: "Reasoning level", initialValue: "medium", options: [{ value: "none", label: "None" }, { value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }] }));
  if (reasoning === undefined) return undefined;
  const timeout = await answer<string>(prompts, prompts.text({ message: "Timeout (ms)", defaultValue: "45000" }));
  if (!provider || !baseURL || !model || !apiKey || !reasoning || !timeout) return undefined;
  const timeoutMs = Number(timeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) throw new Error("Timeout must be between 1000 and 300000 ms");
  const config = { provider, baseURL, model, apiKey, ...(reasoning === "none" ? {} : { reasoningEffort: reasoning as "low" | "medium" | "high" }), timeoutMs };
  validateDirectSetupConfig(config);
  return config;
}

async function maskedPassword({ message }: { message: string }): Promise<unknown> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("An interactive terminal is required to enter the Direct API key");
  process.stdout.write(`◆  ${message}\n│  `);
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding("utf8");
  let value = "";
  return new Promise((resolve) => {
    const finish = (result: string | symbol): void => { process.stdin.off("data", onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write("\n"); resolve(result); };
    const onData = (chunk: string): void => { for (const character of chunk) { if (character === "\u0003") return finish(SETUP_CANCELLED); if (character === "\r" || character === "\n") return finish(value); if (character === "\u007f") { if (value) { value = value.slice(0, -1); process.stdout.write("\b \b"); } continue; } if (character >= " ") { value += character; process.stdout.write("•"); } } };
    process.stdin.on("data", onData);
  });
}

async function answer<T>(prompts: SetupPrompts, pending: Promise<unknown>): Promise<T | undefined> {
  const value = await pending;
  return prompts.isCancel(value) ? undefined : value as T;
}

function cancelled(prompts: SetupPrompts): SetupResult {
  prompts.cancel("Setup cancelled; existing configuration and worker state are unchanged");
  return { saved: false };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  runSetup().catch((error: unknown) => { console.error(`Smart Rename: ${errorMessage(error)}`); process.exitCode = 1; });
}
