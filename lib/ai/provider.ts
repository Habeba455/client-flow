import { DEFAULT_ANTHROPIC_MODEL } from '@/lib/ai/spec-models';

interface ModelMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface GenerateTextOptions {
  system?: string;
  messages: ModelMessage[];
  maxTokens?: number;
  temperature?: number;
  responseMimeType?: string;
  preferredProvider?: 'anthropic' | 'openai' | 'gemini';
  model?: string;
}

const RETRYABLE_PROVIDER_STATUS_CODES = [408, 409, 425, 429, 500, 502, 503, 504, 529];

function getProvider(): 'anthropic' | 'openai' | 'gemini' {
  const configured = (process.env.AI_PROVIDER || '').toLowerCase();
  if (configured === 'anthropic' || configured === 'openai' || configured === 'gemini') {
    return configured;
  }
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'gemini';
}

function getAvailableProviders(preferredProvider?: 'anthropic' | 'openai' | 'gemini'): Array<'anthropic' | 'openai' | 'gemini'> {
  if (preferredProvider) {
    const configuredProviders = {
      anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
      openai: Boolean(process.env.OPENAI_API_KEY),
      gemini: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
    } as const;

    if (preferredProvider === 'gemini') {
      return configuredProviders.gemini ? ['gemini'] : [];
    }

    const ordered = preferredProvider === 'anthropic' ? (['anthropic', 'openai'] as const) : (['openai', 'anthropic'] as const);
    return ordered.filter((provider) => configuredProviders[provider]);
  }

  const preferred = preferredProvider || getProvider();
  const ordered =
    preferred === 'gemini'
      ? (['gemini'] as const)
      : preferred === 'openai'
        ? (['openai', 'anthropic'] as const)
        : (['anthropic', 'openai'] as const);
  const unique = [...new Set(ordered)];

  return unique.filter((provider) => {
    if (provider === 'anthropic') return Boolean(process.env.ANTHROPIC_API_KEY);
    if (provider === 'openai') return Boolean(process.env.OPENAI_API_KEY);
    return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  });
}

function parseProviderStatusCode(message: string): number | null {
  const match = message.match(/\bfailed with (\d{3})\b/i) || message.match(/\bHTTP (\d{3})\b/i);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRetryableProviderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const status = parseProviderStatusCode(message);
  if (status && RETRYABLE_PROVIDER_STATUS_CODES.includes(status)) {
    return true;
  }
  return /\boverloaded\b|\btimeout\b|\btemporar(?:y|ily)\b|\brate limit\b/i.test(message);
}

function isProviderFailureMessage(message: string): boolean {
  return /\b(anthropic|openai|gemini) request failed\b/i.test(message) || /\bRESOURCE_EXHAUSTED\b/i.test(message);
}

export function sanitizeProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isProviderFailureMessage(message)) {
    return 'The assistant is temporarily unavailable due to an AI provider issue. Please try again in a moment.';
  }
  return message || 'The assistant is temporarily unavailable. Please try again.';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function generateWithAnthropic(options: GenerateTextOptions): Promise<string> {
  const apiKey = requireEnv('ANTHROPIC_API_KEY');
  const model = options.model || DEFAULT_ANTHROPIC_MODEL;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      system: options.system,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.2,
      messages: options.messages,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Anthropic request failed with ${response.status}: ${detail}`);
  }

  const data = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n').trim();
  if (!text) {
    throw new Error('Anthropic response did not contain text');
  }
  return text;
}

async function generateWithOpenAI(options: GenerateTextOptions): Promise<string> {
  const apiKey = requireEnv('OPENAI_API_KEY');
  const model = options.model?.startsWith('claude-')
    ? (process.env.OPENAI_MODEL || 'gpt-4.1-mini')
    : (options.model || process.env.OPENAI_MODEL || 'gpt-4.1-mini');
  const messages = options.system
    ? [{ role: 'system', content: options.system }, ...options.messages]
    : options.messages;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: options.temperature ?? 0.2,
      max_completion_tokens: options.maxTokens ?? 4096,
      response_format: options.responseMimeType === 'application/json' ? { type: 'json_object' } : undefined,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI request failed with ${response.status}: ${detail}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error('OpenAI response did not contain text');
  }
  return text;
}

async function generateWithGemini(options: GenerateTextOptions): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY is required');
  }
  const model = options.model || process.env.GEMINI_MODEL || 'gemini-2.0-flash';

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: options.system
          ? {
              parts: [{ text: options.system }],
            }
          : undefined,
        contents: options.messages.map((message) => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        })),
        generationConfig: {
          temperature: options.temperature ?? 0.2,
          maxOutputTokens: options.maxTokens ?? 4096,
          responseMimeType: options.responseMimeType,
        },
      }),
    }
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini request failed with ${response.status}: ${detail}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('\n').trim();
  if (!text) {
    throw new Error('Gemini response did not contain text');
  }
  return text;
}

export async function generateText(options: GenerateTextOptions): Promise<string> {
  const providers = getAvailableProviders(options.preferredProvider);
  const errors: string[] = [];

  if (providers.length === 0) {
    throw new Error(
      options.preferredProvider
        ? `Preferred AI provider "${options.preferredProvider}" is not configured.`
        : 'No AI provider is configured.'
    );
  }

  for (const provider of providers) {
    const maxAttempts = provider === 'anthropic' ? 3 : 2;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        if (provider === 'anthropic') return await generateWithAnthropic(options);
        if (provider === 'openai') return await generateWithOpenAI(options);
        return await generateWithGemini(options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retryable = isRetryableProviderError(error);
        errors.push(`${provider}[attempt ${attempt + 1}]: ${message}`);

        if (!retryable || attempt === maxAttempts - 1) {
          break;
        }

        await sleep(600 * (attempt + 1));
      }
    }
  }

  throw new Error(errors.join(' | ') || 'No AI provider is configured.');
}

class InvalidJsonResponseError extends Error {
  rawText: string;
  payload: string;

  constructor(message: string, rawText: string, payload: string, cause?: unknown) {
    super(message);
    this.name = 'InvalidJsonResponseError';
    this.rawText = rawText;
    this.payload = payload;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

function extractJsonPayload(text: string): string {
  const fencedMatch = text.match(/```json\s*([\s\S]*?)```/i);
  return fencedMatch?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0] ?? text;
}

function normalizeJsonPayload(text: string): string {
  return extractJsonPayload(text)
    .replace(/^\uFEFF/, '')
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
}

function summarizeJsonParseFailure(payload: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const positionMatch = message.match(/position (\d+)/i);
  const position = positionMatch ? Number.parseInt(positionMatch[1] || '', 10) : Number.NaN;
  const start = Number.isFinite(position) ? Math.max(0, position - 120) : 0;
  const end = Number.isFinite(position) ? Math.min(payload.length, position + 120) : Math.min(payload.length, 240);
  const snippet = payload.slice(start, end).replace(/\s+/g, ' ').trim();
  return snippet ? `${message} | Around parse failure: ${snippet}` : message;
}

function parseJsonResponse<T>(text: string): T {
  const payload = normalizeJsonPayload(text);

  try {
    return JSON.parse(payload) as T;
  } catch (error) {
    throw new InvalidJsonResponseError(summarizeJsonParseFailure(payload, error), text, payload, error);
  }
}

function estimateJsonOutputTokens(text: string): number {
  return Math.ceil(text.length / 4) + 768;
}

function getExpandedJsonRetryTokens(maxTokens: number | undefined, payload: string): number {
  const base = maxTokens ?? 4096;
  const expanded = Math.max(base + 1500, estimateJsonOutputTokens(payload));
  return Math.min(Math.max(expanded, 1500), 12000);
}

function getJsonRepairProvider(preferredProvider?: 'anthropic' | 'openai' | 'gemini'): 'anthropic' | 'openai' | 'gemini' | undefined {
  if (process.env.OPENAI_API_KEY) {
    return 'openai';
  }
  return preferredProvider;
}

async function repairJsonResponse<T>(error: InvalidJsonResponseError, options: GenerateTextOptions, maxTokens: number): Promise<T> {
  const text = await generateText({
    system:
      'You repair malformed JSON. Return valid JSON only with no markdown fences. Preserve the original structure, keys, array order, and wording wherever possible. If a fragment is clearly malformed or truncated, fix only what is required to produce valid JSON.',
    messages: [
      {
        role: 'user',
        content: ['Repair this malformed JSON and return valid JSON only.', '', 'Malformed JSON:', '```json', error.payload, '```'].join('\n'),
      },
    ],
    maxTokens,
    temperature: 0,
    responseMimeType: 'application/json',
    preferredProvider: getJsonRepairProvider(options.preferredProvider),
  });

  return parseJsonResponse<T>(text);
}

export async function generateJson<T>(options: GenerateTextOptions): Promise<T> {
  const attempt = async (messages: ModelMessage[], maxTokens = options.maxTokens) => {
    const text = await generateText({ ...options, messages, maxTokens, responseMimeType: 'application/json' });
    return parseJsonResponse<T>(text);
  };

  try {
    return await attempt(options.messages);
  } catch (error) {
    if (!(error instanceof InvalidJsonResponseError)) {
      throw error;
    }

    const expandedMaxTokens = getExpandedJsonRetryTokens(options.maxTokens, error.payload);

    try {
      return await attempt(
        [
          ...options.messages,
          {
            role: 'user',
            content:
              'Your previous response was not valid JSON. Respond again with JSON only and no markdown fences. Keep the JSON compact, syntactically valid, and complete.',
          },
        ],
        expandedMaxTokens
      );
    } catch (retryError) {
      if (!(retryError instanceof InvalidJsonResponseError)) {
        throw retryError;
      }

      return repairJsonResponse<T>(retryError, options, expandedMaxTokens);
    }
  }
}
