import type { NamingContext, NameSuggestion } from "./domain.ts";
import { loadModelSelection } from "./model-selection.ts";
import { ModelSourceError, type ModelSelection, type ModelSource } from "./model-source.ts";
import { loadModelSource } from "./model-sources/index.ts";
import { AiSdkNamer, loadNamingPrompt, parseSuggestion, type Namer } from "./provider.ts";

export type ModelSourceFactory = (selection: ModelSelection, env: NodeJS.ProcessEnv) => Promise<ModelSource>;

export class ModelSourceNamer implements Namer {
  #active: { key: string; source: ModelSource } | undefined;
  readonly #direct: Namer;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly sourceFactory: ModelSourceFactory = loadModelSource,
    direct: Namer = new AiSdkNamer(env),
  ) {
    this.#direct = direct;
  }

  async suggest(context: NamingContext): Promise<NameSuggestion> {
    const selection = await loadModelSelection(this.env.HERDR_PLUGIN_CONFIG_DIR, this.env);
    if (selection.source === "direct") {
      await this.close();
      return this.#direct.suggest(context);
    }
    const source = await this.sourceFor(selection);
    const system = await loadNamingPrompt(this.env);
    try {
      return parseSuggestion(await source.complete({
        selection,
        context,
        system,
        prompt: `Suggest one label from this sanitized context:\n${JSON.stringify(context)}`,
        maxOutputTokens: 32_768,
        maxRetries: 1,
        // Same request tripwire as the existing default Direct configuration.
        abortSignal: AbortSignal.timeout(45_000),
      }));
    } catch (error) {
      if (error instanceof ModelSourceError) throw error;
      throw new Error(`AI ${selection.source} source failed. Run setup to check ${selection.provider}/${selection.model}.`);
    }
  }

  async close(): Promise<void> {
    const active = this.#active;
    this.#active = undefined;
    await active?.source.close?.();
  }

  private async sourceFor(selection: ModelSelection): Promise<ModelSource> {
    const key = JSON.stringify(selection);
    if (this.#active?.key === key) return this.#active.source;
    await this.close();
    const source = await this.sourceFactory(selection, this.env);
    this.#active = { key, source };
    return source;
  }
}
