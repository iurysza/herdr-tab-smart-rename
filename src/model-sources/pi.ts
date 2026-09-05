import type {
  Api,
  Context,
  Model,
  ModelThinkingLevel,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  ModelSourceError,
  type ModelCompletionRequest,
  type ModelSelection,
  type ModelSource,
  type ModelProfile,
  type ProviderChoice,
  type ModelChoice,
} from "../model-source.ts";

export interface PiModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
}

export interface PiAssistantMessage {
  content: ReadonlyArray<{ type: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
}

export interface PiRuntime {
  getAvailable(providerId?: string): Promise<readonly PiModel[]>;
  getModel(providerId: string, modelId: string): PiModel | undefined;
  completeSimple(
    model: PiModel,
    context: Context,
    options: {
      reasoning?: string;
      maxTokens: number;
      maxRetries: number;
      signal: AbortSignal;
    },
  ): Promise<PiAssistantMessage>;
}

export interface PiRuntimeResources {
  runtime: PiRuntime;
  profiles(model: PiModel): readonly string[];
}

export type PiRuntimeFactory = () => Promise<PiRuntimeResources>;

export class PiModelSource implements ModelSource {
  readonly id = "pi" as const;
  readonly #runtimeFactory: PiRuntimeFactory;
  #resources: PiRuntimeResources | undefined;

  constructor(runtimeFactory: PiRuntimeFactory = createPiRuntime) {
    this.#runtimeFactory = runtimeFactory;
  }

  async listProviders(): Promise<readonly ProviderChoice[]> {
    const models = await (await this.resources()).runtime.getAvailable();
    return [...new Map(models.map((model) => [model.provider, model])).entries()]
      .map(([id, model]) => ({ id, label: id || model.provider }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  async listModels(providerId: string): Promise<readonly ModelChoice[]> {
    const models = await (await this.resources()).runtime.getAvailable(providerId);
    if (!models.length) {
      throw new ModelSourceError(
        "authentication",
        "Pi provider is not connected. Sign in to Pi, then run setup.",
      );
    }
    return models.map((model) => ({ id: model.id, label: model.name || model.id }));
  }

  async listProfiles(
    providerId: string,
    modelId: string,
  ): Promise<readonly ModelProfile[]> {
    const model = await this.availableModel(providerId, modelId);
    return this.profileIds(model).map((id) => ({ id, label: id }));
  }

  async validate(selection: ModelSelection): Promise<void> {
    if (selection.source !== "pi") {
      throw new ModelSourceError("source", "Pi AI is not selected. Run setup.");
    }
    const model = await this.availableModel(selection.provider, selection.model);
    this.assertProfile(model, selection.profile);
  }

  async complete(request: ModelCompletionRequest): Promise<string> {
    await this.validate(request.selection);
    const resources = await this.resources();
    const model = await this.availableModel(
      request.selection.provider,
      request.selection.model,
    );
    try {
      const response = await resources.runtime.completeSimple(
        model,
        {
          systemPrompt: request.system,
          messages: [
            {
              role: "user",
              content: request.prompt,
              timestamp: Date.now(),
            },
          ],
        },
        {
          ...(request.selection.profile && request.selection.profile !== "off"
            ? { reasoning: request.selection.profile }
            : {}),
          maxTokens: request.maxOutputTokens,
          maxRetries: request.maxRetries,
          signal: request.abortSignal,
        },
      );
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(response.errorMessage || "Pi completion failed");
      }
      const text = response.content
        .filter((part) => part.type === "text")
        .map((part) => part.text || "")
        .join("")
        .trim();
      if (!text) throw new Error("Pi returned no text");
      return text;
    } catch {
      throw new ModelSourceError(
        "request",
        "Pi request failed. Check Pi authentication and the selected provider/model.",
      );
    }
  }

  private async resources(): Promise<PiRuntimeResources> {
    this.#resources ??= await this.#runtimeFactory();
    return this.#resources;
  }

  private async availableModel(providerId: string, modelId: string): Promise<PiModel> {
    const resources = await this.resources();
    const available = await resources.runtime.getAvailable(providerId);
    const model = resources.runtime.getModel(providerId, modelId);
    if (!model) {
      throw new ModelSourceError("model", "Pi model is unavailable. Run setup to choose another model.");
    }
    if (!available.some((item) => item.id === model.id && item.provider === model.provider)) {
      throw new ModelSourceError(
        "authentication",
        "Pi provider is not connected. Sign in to Pi, then run setup.",
      );
    }
    return model;
  }

  private profileIds(model: PiModel): readonly string[] {
    return model.reasoning ? this.#resources?.profiles(model) ?? [] : [];
  }

  private assertProfile(model: PiModel, profile: string | undefined): void {
    if (!profile) return;
    if (!this.profileIds(model).includes(profile)) {
      throw new ModelSourceError("profile", "Pi thinking level is unavailable. Run setup.");
    }
  }
}

async function createPiRuntime(): Promise<PiRuntimeResources> {
  const [{ ModelRuntime }, { getSupportedThinkingLevels }] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("@earendil-works/pi-ai"),
  ]);
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  return {
    runtime: {
      getAvailable: (providerId) => runtime.getAvailable(providerId),
      getModel: (providerId, modelId) => runtime.getModel(providerId, modelId),
      completeSimple: (model, context, options) =>
        runtime.completeSimple(model as Model<Api>, context, {
          ...(options.reasoning
            ? { reasoning: options.reasoning as ThinkingLevel }
            : {}),
          maxTokens: options.maxTokens,
          maxRetries: options.maxRetries,
          signal: options.signal,
        }),
    },
    profiles: (model) =>
      getSupportedThinkingLevels(model as Model<Api>) as readonly ModelThinkingLevel[],
  };
}
