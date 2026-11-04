export type AnthropicModelTier = 'sonnet' | 'opus';

export const ANTHROPIC_SPEC_MODELS = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
} as const;

export const DEFAULT_ANTHROPIC_MODEL = ANTHROPIC_SPEC_MODELS.sonnet;

export function getAnthropicSpecModel(tier: AnthropicModelTier): string {
  return ANTHROPIC_SPEC_MODELS[tier];
}