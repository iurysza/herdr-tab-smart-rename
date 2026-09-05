import type { NamingContext } from "./domain.ts";

export const MODEL_SOURCE_IDS = ["direct", "pi", "opencode"] as const;
export type ModelSourceId = (typeof MODEL_SOURCE_IDS)[number];

export interface ProviderChoice {
  id: string;
  label: string;
}

export interface ModelChoice {
  id: string;
  label: string;
}

export interface ModelProfile {
  id: string;
  label: string;
}

export interface ModelSelection {
  version: 1;
  source: ModelSourceId;
  provider: string;
  model: string;
  profile?: string | undefined;
}

export interface ModelCompletionRequest {
  selection: ModelSelection;
  context: NamingContext;
  system: string;
  prompt: string;
  maxOutputTokens: number;
  maxRetries: number;
  abortSignal: AbortSignal;
}

export type ModelSourceFailureKind =
  | "source"
  | "provider"
  | "model"
  | "profile"
  | "authentication"
  | "request";

export class ModelSourceError extends Error {
  readonly kind: ModelSourceFailureKind;

  constructor(kind: ModelSourceFailureKind, message: string) {
    super(message);
    this.name = "ModelSourceError";
    this.kind = kind;
  }
}

export interface ModelSource {
  readonly id: ModelSourceId;
  listProviders(): Promise<readonly ProviderChoice[]>;
  listModels(providerId: string): Promise<readonly ModelChoice[]>;
  listProfiles(
    providerId: string,
    modelId: string,
  ): Promise<readonly ModelProfile[]>;
  validate(selection: ModelSelection): Promise<void>;
  complete(request: ModelCompletionRequest): Promise<string>;
  close?(): Promise<void>;
}

export function selectionLabel(selection: ModelSelection): string {
  return [
    selection.source,
    `${selection.provider}/${selection.model}`,
    ...(selection.profile ? [selection.profile] : []),
  ].join(" ");
}
