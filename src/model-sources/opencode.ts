import {
  ModelSourceError,
  type ModelCompletionRequest,
  type ModelSelection,
  type ModelSource,
  type ModelProfile,
  type ProviderChoice,
  type ModelChoice,
} from "../model-source.ts";

interface OpenCodeModel {
  id: string;
  name: string;
  variants?: Record<string, { disabled?: boolean }>;
}

interface OpenCodeProvider {
  id: string;
  name: string;
  models: Record<string, OpenCodeModel>;
}

interface OpenCodeClient {
  provider: {
    list(input?: { directory?: string }, options?: { signal?: AbortSignal }): Promise<{
      data?: { all: OpenCodeProvider[]; connected: string[] } | undefined;
    }>;
  };
  tool: {
    ids(input?: { directory?: string }, options?: { signal?: AbortSignal }): Promise<{ data?: string[] | undefined }>;
  };
  session: {
    create(input: {
      directory?: string;
      title?: string;
      model?: { providerID: string; id: string; variant?: string };
      permission?: Array<{ permission: string; pattern: string; action: "deny" }>;
    }, options?: { signal?: AbortSignal }): Promise<{ data?: { id: string } | undefined }>;
    prompt(
      input: {
        sessionID: string;
        directory?: string;
        model: { providerID: string; modelID: string };
        system: string;
        variant?: string;
        tools: Record<string, false>;
        parts: Array<{ type: "text"; text: string }>;
      },
      options?: { signal?: AbortSignal },
    ): Promise<{
      data?: { parts: Array<{ type: string; text?: string }> } | undefined;
    }>;
    delete(input: { sessionID: string; directory?: string }, options?: { signal?: AbortSignal }): Promise<unknown>;
  };
}

// OpenCode 1.18.x may still show these tools to the provider. Session permission is
// the execution boundary; the per-tool map remains an explicit disable request.
const denyAllPermissions = [{ permission: "*", pattern: "*", action: "deny" }] as const;

interface OpenCodeServer {
  close(): void;
}

interface OpenCodeResources {
  client: OpenCodeClient;
  server: OpenCodeServer;
}

export type OpenCodeFactory = (signal?: AbortSignal) => Promise<OpenCodeResources>;

export class OpenCodeModelSource implements ModelSource {
  readonly id = "opencode" as const;
  readonly #factory: OpenCodeFactory;
  readonly #directory: string;
  #resources: OpenCodeResources | undefined;

  constructor(
    factory: OpenCodeFactory = createOpenCodeResources,
    directory = process.cwd(),
  ) {
    this.#factory = factory;
    this.#directory = directory;
  }

  async listProviders(): Promise<readonly ProviderChoice[]> {
    const catalog = await this.catalog();
    return catalog.providers.map((provider) => ({
      id: provider.id,
      label: provider.name || provider.id,
    }));
  }

  async listModels(providerId: string): Promise<readonly ModelChoice[]> {
    const provider = await this.connectedProvider(providerId);
    return Object.values(provider.models).map((model) => ({
      id: model.id,
      label: model.name || model.id,
    }));
  }

  async listProfiles(
    providerId: string,
    modelId: string,
  ): Promise<readonly ModelProfile[]> {
    const model = await this.connectedModel(providerId, modelId);
    return Object.entries(model.variants ?? {})
      .filter(([, value]) => value.disabled !== true)
      .map(([id]) => ({ id, label: id }));
  }

  async validate(selection: ModelSelection, signal?: AbortSignal): Promise<void> {
    if (selection.source !== "opencode") {
      throw new ModelSourceError("source", "OpenCode AI is not selected. Run setup.");
    }
    const model = await this.connectedModel(selection.provider, selection.model, signal);
    if (selection.profile) {
      if (!model.variants?.[selection.profile] || model.variants[selection.profile]?.disabled) {
        throw new ModelSourceError(
          "profile",
          "OpenCode variant is unavailable. Run setup.",
        );
      }
    }
  }

  async complete(request: ModelCompletionRequest): Promise<string> {
    const signal = request.abortSignal;
    signal.throwIfAborted();
    const client = (await this.resources(signal)).client;
    let sessionId: string | undefined;
    try {
      signal.throwIfAborted();
      await this.validate(request.selection, signal);
      const toolIds = (await client.tool.ids({ directory: this.#directory }, { signal })).data;
      if (!toolIds) throw new Error("OpenCode did not list available tools");
      const tools = Object.fromEntries(toolIds.map((id) => [id, false])) as Record<string, false>;
      const created = await client.session.create({
        directory: this.#directory,
        title: "Smart Rename",
        model: {
          providerID: request.selection.provider,
          id: request.selection.model,
          ...(request.selection.profile
            ? { variant: request.selection.profile }
            : {}),
        },
        permission: [...denyAllPermissions],
      }, { signal });
      sessionId = created.data?.id;
      if (!sessionId) throw new Error("OpenCode did not create a session");
      const response = await client.session.prompt({
        sessionID: sessionId,
        directory: this.#directory,
        model: {
          providerID: request.selection.provider,
          modelID: request.selection.model,
        },
        system: request.system,
        ...(request.selection.profile
          ? { variant: request.selection.profile }
          : {}),
        tools,
        parts: [{ type: "text", text: request.prompt }],
      }, { signal: request.abortSignal });
      const text = response.data?.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text || "")
        .join("")
        .trim();
      if (!text) throw new Error("OpenCode returned no text");
      return text;
    } catch {
      throw new ModelSourceError(
        "request",
        "OpenCode request failed. Check OpenCode authentication and the selected provider/model.",
      );
    } finally {
      if (sessionId) {
        await client.session
          .delete({ sessionID: sessionId, directory: this.#directory }, { signal })
          .catch(() => {});
      }
      await this.close();
    }
  }

  async close(): Promise<void> {
    const resources = this.#resources;
    this.#resources = undefined;
    resources?.server.close();
  }

  private async resources(signal?: AbortSignal): Promise<OpenCodeResources> {
    this.#resources ??= await this.#factory(signal);
    return this.#resources;
  }

  private async catalog(signal?: AbortSignal): Promise<{
    providers: OpenCodeProvider[];
  }> {
    try {
      const result = await (await this.resources(signal)).client.provider.list({
        directory: this.#directory,
      }, signal ? { signal } : undefined);
      const catalog = result.data;
      if (!catalog) throw new Error("OpenCode returned no provider catalog");
      const connected = new Set(catalog.connected);
      return { providers: catalog.all.filter((provider) => connected.has(provider.id)) };
    } catch {
      throw new ModelSourceError(
        "authentication",
        "OpenCode providers are unavailable. Sign in to OpenCode, then run setup.",
      );
    }
  }

  private async connectedProvider(providerId: string, signal?: AbortSignal): Promise<OpenCodeProvider> {
    const provider = (await this.catalog(signal)).providers.find(
      (item) => item.id === providerId,
    );
    if (!provider) {
      throw new ModelSourceError(
        "authentication",
        "OpenCode provider is not connected. Sign in to OpenCode, then run setup.",
      );
    }
    return provider;
  }

  private async connectedModel(
    providerId: string,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<OpenCodeModel> {
    const provider = await this.connectedProvider(providerId, signal);
    const model = Object.values(provider.models).find((item) => item.id === modelId);
    if (!model) {
      throw new ModelSourceError(
        "model",
        "OpenCode model is unavailable. Run setup to choose another model.",
      );
    }
    return model;
  }
}

async function createOpenCodeResources(signal?: AbortSignal): Promise<OpenCodeResources> {
  const { createOpencodeClient, createOpencodeServer } = await import(
    "@opencode-ai/sdk/v2"
  );
  const server = await createOpencodeServer({ hostname: "127.0.0.1", port: 0, ...(signal ? { signal } : {}) });
  return {
    server,
    client: createOpencodeClient({ baseUrl: server.url, directory: process.cwd() }),
  };
}
