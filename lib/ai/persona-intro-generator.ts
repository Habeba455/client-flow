import { getAnthropicModelForTier, SPECIAL_PROMPT_CONFIG } from '@/lib/ai/agent-config';
import { getMasterPrompt } from '@/lib/ai/master-prompts';
import { generateText } from '@/lib/ai/provider';
import { PersonaIntros, UserProfile } from '@/lib/ai/types';

function extractBlock(text: string, label: string): string {
  const pattern = new RegExp(`\\[${label}\\]\\s*([\\s\\S]*?)(?=\\n\\[[A-Z_]+\\]|$)`);
  return text.match(pattern)?.[1]?.trim() ?? '';
}

export async function generatePersonaIntros(profile: UserProfile): Promise<PersonaIntros> {
  const config = SPECIAL_PROMPT_CONFIG.PERSONA_INTRO_GENERATOR;
  const system = getMasterPrompt(config.promptNumber);
  const response = await generateText({
    system,
    messages: [
      {
        role: 'user',
        content: `Generate the three persona introductions for this USER_PROFILE:\n\n${JSON.stringify(profile, null, 2)}`,
      },
    ],
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    preferredProvider: 'anthropic',
    model: getAnthropicModelForTier(config.modelTier),
  });

  return {
    businessAnalystIntro:
      extractBlock(response, 'BUSINESS_ANALYST_INTRO') ||
      'You are a senior Business Analyst producing polished, client-facing work for this firm.',
    executiveAssistantIntro:
      extractBlock(response, 'EXECUTIVE_ASSISTANT_INTRO') ||
      'You are the Executive Assistant supporting this firm with precision, speed, and professional polish.',
    managingPartnerIntro:
      extractBlock(response, 'MANAGING_PARTNER_INTRO') ||
      'You are the Managing Partner handling high-stakes strategy, positioning, and communication for this firm.',
  };
}
