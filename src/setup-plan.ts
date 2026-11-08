import { selectionLabel, type ModelSelection } from "./model-source.ts";
import type { KeybindingInspection } from "./setup-keybindings.ts";

export interface SetupDraft {
  readonly selection: ModelSelection;
  readonly action: "keep" | "replace";
  readonly keybindings?: KeybindingInspection;
}

export function setupReview(draft: SetupDraft): string {
  const lines = [
    `AI: ${selectionLabel(draft.selection)}`,
    `Configuration: ${draft.action}`,
  ];

  if (draft.keybindings) lines.push("Keybinding guidance (read-only):", renderKeybindingGuidance(draft.keybindings));

  return lines.join("\n");
}

export function renderKeybindingGuidance(
  inspection: KeybindingInspection,
): string {
  const lines = [
    `Runtime config path: ${inspection.path ?? "unavailable"}`,
  ];

  if (inspection.uncertainty) {
    lines.push(`Ownership uncertainty: ${inspection.uncertainty}`);
  }

  for (const result of inspection.results) {
    lines.push(`${result.instruction.label}: ${result.status}`);

    if (result.diagnostic) lines.push(`Diagnostic: ${result.diagnostic}`);

    if (result.status !== "already-configured") {
      lines.push(`Proposed TOML for ${result.instruction.action}:`);
      lines.push(result.instruction.toml);
    }
  }

  lines.push(`Remote attach: ${inspection.remoteAttachNote}`);

  return lines.join("\n");
}

export function requiresDirectConfig(selection: ModelSelection): boolean {
  return selection.source === "direct";
}
