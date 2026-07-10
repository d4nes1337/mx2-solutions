import Anthropic from "@anthropic-ai/sdk";

/**
 * Thin seam around the Anthropic SDK: the generator consumes this one-method
 * interface so route tests can script model turns without any network. Only
 * ever constructed when FEATURE_AI_CHAT is on and a key is present (config
 * fails closed otherwise).
 */
export interface AiClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export const createAnthropicAiClient = (opts: { apiKey: string; timeoutMs?: number }): AiClient => {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    timeout: opts.timeoutMs ?? 60_000,
    maxRetries: 1,
  });
  return {
    create: (params) => client.messages.create(params),
  };
};
