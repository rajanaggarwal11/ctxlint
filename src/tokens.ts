import { encode } from "gpt-tokenizer";

/**
 * A tokenizer estimate. gpt-tokenizer's default encoding (o200k) is exact for
 * current OpenAI models and a close proxy for Anthropic's; every number derived
 * from it is calibrated against the provider's own total before it is shown.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}
