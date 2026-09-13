export type ReasoningEffort = "low" | "medium" | "high";

export interface DirectProviderProfile {
  readonly id: string;
  readonly label: string;
  readonly defaultBaseURL?: string;
  readonly defaultModel?: string;
  readonly defaultReasoningEffort?: ReasoningEffort;
  readonly apiKeyEnvNames: readonly string[];
}

export const DEFAULT_DIRECT_PROVIDER_ID = "openai";

const DIRECT_PROVIDER_PROFILES: readonly DirectProviderProfile[] = [
  {
    id: DEFAULT_DIRECT_PROVIDER_ID,
    label: "OpenAI",
    defaultBaseURL: "https://api.openai.com/v1",
    defaultModel: "gpt-5.6-luna",
    defaultReasoningEffort: "medium",
    apiKeyEnvNames: ["OPENAI_API_KEY"],
  },
  {
    id: "kimi-code",
    label: "Kimi Code",
    apiKeyEnvNames: ["KIMI_API_KEY"],
  },
] as const;

export function directProviderProfiles(): readonly DirectProviderProfile[] {
  return DIRECT_PROVIDER_PROFILES;
}

export function directProviderProfile(
  provider: string,
): DirectProviderProfile | undefined {
  return DIRECT_PROVIDER_PROFILES.find((profile) => profile.id === provider);
}

export function defaultDirectProviderProfile(): DirectProviderProfile {
  const profile = directProviderProfile(DEFAULT_DIRECT_PROVIDER_ID);
  if (!profile) throw new Error("Default direct provider is not registered");
  return profile;
}
