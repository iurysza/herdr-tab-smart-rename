import type { ModelSelection, ModelSource } from "../model-source.ts";

export async function loadModelSource(
  selection: ModelSelection,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ModelSource> {
  switch (selection.source) {
    case "direct": {
      const { DirectModelSource } = await import("./direct.ts");
      return new DirectModelSource(env);
    }
    case "pi": {
      const { PiModelSource } = await import("./pi.ts");
      return new PiModelSource();
    }
    case "opencode": {
      const { OpenCodeModelSource } = await import("./opencode.ts");
      return new OpenCodeModelSource(undefined, env.HERDR_PLUGIN_ROOT || process.cwd());
    }
  }
}
