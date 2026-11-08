import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { NativeActivation, NativeInstallPaths } from "./native-service.ts";

// The in-app trigger: a headless herdr-app mod opened by one key. Opening it runs
// `rename-now` for the focused tab through the installed payload, toasts, and closes.
export const TRIGGER_MOD = "smart-rename";

export const TRIGGER_KEY = "ctrl-shift-r";

export const TRIGGER_ACTION = `mod.open:${TRIGGER_MOD}`;

const OWNER_MARK = "// owner: herdr-tab-smart-rename/native-service (rewritten on install, removed on uninstall)";

export type TriggerModStatus = "installed" | "removed" | "absent" | "foreign";

export type TriggerKeyStatus = "added" | "already-bound" | "colliding" | "removed" | "absent" | "no-keys-file" | "invalid-keys-file";

export interface TriggerResult {
  mod: TriggerModStatus;
  key: TriggerKeyStatus;
  keys: string;
  backup?: string;
}

export interface TriggerFiles {
  "main.js": string;
  "mod.json": string;
}

const KeysSchema = z.record(z.string(), z.record(z.string(), z.unknown()));

type Keys = z.infer<typeof KeysSchema>;

const Enoent = z.object({ code: z.literal("ENOENT") });

type KeysRead = { kind: "ok"; text: string; keys: Keys } | { kind: "no-keys-file" } | { kind: "invalid-keys-file" };

async function readIfPresent(file: string): Promise<string | null> {
  try { return await readFile(file, "utf8"); } catch (error) {
    if (Enoent.safeParse(error).success) return null;
    throw error;
  }
}

export function triggerModDirectory(appHome: string): string {
  return path.join(appHome, "mods", TRIGGER_MOD);
}

export function renderTriggerMod(activation: NativeActivation, paths: NativeInstallPaths): TriggerFiles {
  const env = Object.entries(activation.env).map(([key, value]) => `${key}=${value}`);
  const root = paths.current;
  const command = ["/usr/bin/env", "-i", ...env, path.join(root, "src/run-bun.sh"), path.join(root, "src/herdr-app-cli.ts"), "rename-now"];
  const tail = ["--config-dir", activation.configDir];

  const main = `// Smart Rename: name the focused tab now.
${OWNER_MARK}
// Opened by a key as a 1×1 headless overlay (keys.json: "${TRIGGER_KEY}": "${TRIGGER_ACTION}").
// On open it runs the installed native CLI for the focused tab (local or machine/ remote),
// shows the result as a toast and closes itself. Nothing is drawn.

import { View, div } from "gpui-kit";
import { exec, focused, notify, props, closeOverlay } from "herdr";

const COMMAND = ${JSON.stringify(command)};
const TAIL = ${JSON.stringify(tail)};
const CWD = ${JSON.stringify(root)};

function describe(result) {
  const changes = result.changes ?? [];
  const change = changes.find((c) => c.kind === "tab") ?? changes[0];
  if (change) return { level: "success", body: \`\${change.from} → \${change.to}\` };
  const failed = (result.outcomes ?? []).find((o) => o.status === "failed");
  if (failed) return { level: "error", body: failed.reason ?? "rename failed" };
  const reason = result.reason ?? (result.outcomes ?? [])[0]?.reason;
  return { level: "info", body: reason ? \`No change: \${reason}\` : "No change" };
}

async function renameNow(tab) {
  try {
    const r = await exec(COMMAND[0], [...COMMAND.slice(1), "--tab", tab, ...TAIL], { cwd: CWD });
    let result = null;
    try { result = JSON.parse(r.stdout); } catch {}
    if (r.code !== 0 && !result) {
      const err = (r.stderr || r.stdout).trim().split("\\n").filter(Boolean).slice(-2).join(" ");
      notify({ title: "Smart Rename failed", body: err || \`exit \${r.code}\`, level: "error", timeout: 8000 });
      return;
    }
    const d = describe(result ?? {});
    notify({ title: "Smart Rename", body: d.body, level: d.level, timeout: d.level === "error" ? 8000 : 4000 });
  } catch (e) {
    notify({ title: "Smart Rename failed", body: String(e?.message ?? e), level: "error", timeout: 8000 });
  }
}

export default class SmartRename extends View {
  init(_props, cx) {
    const overlay = props()?.overlay;
    const tab = focused()?.tab;
    if (!tab) notify({ title: "Smart Rename", body: "No focused tab", level: "warning", timeout: 3000 });
    else {
      notify({ title: "Smart Rename", body: "Naming tab…", level: "info", timeout: 2500 });
      cx.spawn(async () => { await renameNow(tab); });
    }
    if (overlay) closeOverlay(overlay);
  }

  render() {
    return div().id("root").size(1);
  }
}
`;

  return { "main.js": main, "mod.json": `{ "place": "none", "title": "Smart Rename", "overlay": { "width": 1, "height": 1 } }\n` };
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporary, text, { mode: 0o644, flag: "wx" });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

// Ours when it is absent or its main.js carries the owner mark. A person's own mod of the same name is foreign.
async function modOwnership(directory: string): Promise<"absent" | "owned" | "foreign"> {
  try {
    const details = await lstat(directory);

    if (!details.isDirectory() || details.isSymbolicLink()) return "foreign";
    const main = await readIfPresent(path.join(directory, "main.js"));

    if (main === null) return (await readdir(directory)).length ? "foreign" : "owned";

    return main.includes(OWNER_MARK) ? "owned" : "foreign";
  } catch (error) {
    if (Enoent.safeParse(error).success) return "absent";
    throw error;
  }
}

async function readKeys(file: string): Promise<KeysRead> {
  let text: string;

  try {
    const details = await lstat(file);

    if (!details.isFile() || details.isSymbolicLink()) return { kind: "invalid-keys-file" };
    text = await readFile(file, "utf8");
  } catch (error) {
    if (Enoent.safeParse(error).success) return { kind: "no-keys-file" };
    throw error;
  }

  try {
    return { kind: "ok", text, keys: KeysSchema.parse(JSON.parse(text)) };
  } catch { return { kind: "invalid-keys-file" }; }
}

function bound(keys: Keys): string[] {
  return Object.keys(keys).filter((section) => TRIGGER_KEY in keys[section]!);
}

// Keeps the person's file: a copy beside it before the only edit, two-space JSON like herdr-app writes.
async function saveKeys(file: string, text: string, keys: Keys, now: () => number): Promise<string> {
  const stamp = new Date(now()).toISOString().slice(0, 10).replaceAll("-", "");
  let backup = `${file}.bak-${stamp}`;

  for (let n = 2; await lstat(backup).then(() => true, () => false); n++) backup = `${file}.bak-${stamp}-${n}`;
  await writeFile(backup, text, { flag: "wx", mode: 0o644 });
  await writeAtomic(file, `${JSON.stringify(keys, null, 2)}\n`);

  return backup;
}

export interface TriggerOptions {
  now?: (() => number) | undefined;
}

export async function installTrigger(
  appHome: string, activation: NativeActivation, paths: NativeInstallPaths, options: TriggerOptions = {},
): Promise<TriggerResult> {
  const directory = triggerModDirectory(appHome);
  const keysFile = path.join(appHome, "keys.json");
  const ownership = await modOwnership(directory);
  const result: TriggerResult = { mod: ownership === "foreign" ? "foreign" : "installed", key: "absent", keys: keysFile };

  if (ownership !== "foreign") {
    await mkdir(directory, { recursive: true, mode: 0o755 });

    for (const [name, text] of Object.entries(renderTriggerMod(activation, paths))) {
      const file = path.join(directory, name);

      if (await readIfPresent(file) !== text) await writeAtomic(file, text);
    }
  }

  const read = await readKeys(keysFile);

  if (read.kind !== "ok") return { ...result, key: read.kind };
  const { text, keys } = read;
  const sections = bound(keys);

  if (sections.some((section) => keys[section]![TRIGGER_KEY] === TRIGGER_ACTION)) return { ...result, key: "already-bound" };

  if (sections.length) return { ...result, key: "colliding" };
  keys.global = { ...keys.global, [TRIGGER_KEY]: TRIGGER_ACTION };
  const backup = await saveKeys(keysFile, text, keys, options.now ?? Date.now);

  return { ...result, key: "added", backup };
}

export async function uninstallTrigger(appHome: string, options: TriggerOptions = {}): Promise<TriggerResult> {
  const directory = triggerModDirectory(appHome);
  const keysFile = path.join(appHome, "keys.json");
  const ownership = await modOwnership(directory);
  const result: TriggerResult = { mod: ownership === "owned" ? "removed" : ownership, key: "absent", keys: keysFile };

  if (ownership === "owned") await rm(directory, { recursive: true, force: true });
  const read = await readKeys(keysFile);

  if (read.kind !== "ok") return { ...result, key: read.kind };
  const { text, keys } = read;
  const ours = bound(keys).filter((section) => keys[section]![TRIGGER_KEY] === TRIGGER_ACTION);

  if (!ours.length) return result;

  for (const section of ours) delete keys[section]![TRIGGER_KEY];
  const backup = await saveKeys(keysFile, text, keys, options.now ?? Date.now);

  return { ...result, key: "removed", backup };
}
