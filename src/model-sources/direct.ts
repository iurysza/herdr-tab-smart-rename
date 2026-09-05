import { loadProviderConfig, completeWithAiSdk, type ProviderConfig } from "../provider.ts";
import { ModelSourceError, type ModelCompletionRequest, type ModelSelection, type ModelSource } from "../model-source.ts";

export class DirectModelSource implements ModelSource {
  readonly id = "direct" as const;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async listProviders() {
    const config = await loadProviderConfig(this.env);
    return [{ id: config.provider, label: config.provider }];
  }

  async listModels(providerId: string) {
    const config = await loadProviderConfig(this.env);
    if (providerId !== config.provider) throw new ModelSourceError("provider", "Direct provider is not configured. Run setup.");
    return [{ id: config.model, label: config.model }];
  }

  async listProfiles(providerId: string, modelId: string) {
    const config = await loadProviderConfig(this.env);
    return providerId === config.provider && modelId === config.model && config.reasoningEffort
      ? [{ id: config.reasoningEffort, label: config.reasoningEffort }]
      : [];
  }

  async validate(selection: ModelSelection): Promise<void> {
    assertSelection(selection, await loadProviderConfig(this.env));
  }

  async complete(request: ModelCompletionRequest): Promise<string> {
    const config = await loadProviderConfig(this.env);
    assertSelection(request.selection, config);
    return completeWithAiSdk({
      config,
      context: request.context,
      system: request.system,
      maxOutputTokens: 32_768,
      maxRetries: 1,
      abortSignal: request.abortSignal,
    });
  }
}

function assertSelection(selection: ModelSelection, config: ProviderConfig): void {
  if (selection.source !== "direct") throw new ModelSourceError("source", "Direct AI is not selected. Run setup.");
  const legacy = selection.provider === "direct" && selection.model === "direct";
  if (!legacy && (selection.provider !== config.provider || selection.model !== config.model)) {
    throw new ModelSourceError("model", "Direct provider settings changed. Run setup to save the current model.");
  }
}
