import { getAnthropicModelForTier, SPECIAL_PROMPT_CONFIG } from '@/lib/ai/agent-config';
import { generateText } from '@/lib/ai/provider';
import { getSpecialPrompt } from '@/lib/ai/master-prompts';
import { ChatMessage, UserProfile } from '@/lib/ai/types';

export interface SettingsTurnResult {
  reply: string;
  profileReady: boolean;
  profile: UserProfile | null;
}

function hasMeaningfulProfile(profile: UserProfile | null): boolean {
  if (!profile) {
    return false;
  }

  const scalarFields = [
    profile.firm_name,
    profile.firm_description,
    profile.primary_industry,
    profile.firm_size,
    profile.client_profile,
    profile.positioning,
    profile.contact_email,
    profile.contact_website,
    profile.user_timezone,
  ];

  const arrayFieldCount = [
    profile.secondary_industries,
    profile.services,
    profile.client_problems,
    profile.credentials,
    profile.geography,
  ].reduce((count, items) => count + items.length, 0);

  const scalarCount = scalarFields.filter((value) => typeof value === 'string' && value.trim().length > 0).length;
  return scalarCount + arrayFieldCount >= 3;
}

function sanitizeProfile(input: Record<string, unknown>): UserProfile {
  const toString = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  };

  const toStringArray = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  };

  return {
    firm_name: toString(input.firm_name),
    firm_description: toString(input.firm_description),
    primary_industry: toString(input.primary_industry),
    secondary_industries: toStringArray(input.secondary_industries),
    firm_size: toString(input.firm_size),
    services: toStringArray(input.services),
    client_profile: toString(input.client_profile),
    client_problems: toStringArray(input.client_problems),
    credentials: toStringArray(input.credentials),
    geography: toStringArray(input.geography),
    positioning: toString(input.positioning),
    contact_email: toString(input.contact_email),
    contact_website: toString(input.contact_website),
  };
}

export async function runSettingsAgentTurn(history: ChatMessage[], userMessage: string): Promise<SettingsTurnResult> {
  const config = SPECIAL_PROMPT_CONFIG.SETTINGS_AGENT;
  const system = getSpecialPrompt('SETTINGS_AGENT');
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = history
    .filter((message): message is ChatMessage & { role: 'user' | 'assistant' } => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ role: message.role, content: message.content }));
  messages.push({ role: 'user' as const, content: userMessage });

  const reply = await generateText({
    system,
    messages,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    preferredProvider: 'anthropic',
    model: getAnthropicModelForTier(config.modelTier),
  });

  const match = reply.match(/\[USER_PROFILE_READY\]\s*(\{[\s\S]*\})/);
  if (!match) {
    const fallbackProfile = await extractProfileFromOnboardingHistory([
      ...history,
      { id: 'settings-user', role: 'user', content: userMessage, createdAt: new Date().toISOString() },
      { id: 'settings-assistant', role: 'assistant', content: reply, createdAt: new Date().toISOString() },
    ]);

    return {
      reply,
      profileReady: hasMeaningfulProfile(fallbackProfile),
      profile: hasMeaningfulProfile(fallbackProfile) ? fallbackProfile : null,
    };
  }

  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    return {
      reply,
      profileReady: true,
      profile: sanitizeProfile(parsed),
    };
  } catch {
    return { reply, profileReady: false, profile: null };
  }
}

const EXTRACT_PROFILE_SYSTEM = `You are extracting a firm profile from a conversation between a user and a Settings Agent.
Output only a single JSON object. No markdown, no code fence, no explanation.
Use exactly these keys (use null or [] where missing): firm_name, firm_description, primary_industry, secondary_industries (array of strings), firm_size, services (array of strings), client_profile, client_problems (array of strings), credentials (array of strings), geography (array of strings), positioning, contact_email, contact_website.`;

/** Extract profile from onboarding conversation when the agent did not output [USER_PROFILE_READY]. */
export async function extractProfileFromOnboardingHistory(history: ChatMessage[]): Promise<UserProfile | null> {
  const messages = history
    .filter((m): m is ChatMessage & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');
  if (!messages.trim()) {
    return null;
  }

  const { generateText } = await import('@/lib/ai/provider');
  const { getAnthropicModelForTier } = await import('@/lib/ai/agent-config');

  const out = await generateText({
    system: EXTRACT_PROFILE_SYSTEM,
    messages: [{ role: 'user', content: `Conversation:\n\n${messages}\n\nExtract the firm profile as JSON.` }],
    maxTokens: 1500,
    temperature: 0.1,
    preferredProvider: 'anthropic',
    model: getAnthropicModelForTier('sonnet'),
  });

  const jsonMatch = out.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    return sanitizeProfile(parsed);
  } catch {
    return null;
  }
}
