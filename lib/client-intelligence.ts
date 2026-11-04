import { generateText } from '@/lib/ai/provider';

export interface ClientResearchSource {
  title: string;
  url: string;
  snippet: string | null;
}

export interface ClientServiceRecommendation {
  serviceCode?: string;
  serviceName: string;
  reasoning: string;
  priority: 'high' | 'medium' | 'low';
}

function dedupeRecommendations(
  recommendations: ClientServiceRecommendation[],
  services: Array<{
    code: string;
    name: string;
    category: string;
    description?: string | null;
  }>
): ClientServiceRecommendation[] {
  const seen = new Set<string>();
  const unique: ClientServiceRecommendation[] = [];

  for (const item of recommendations) {
    const key = `${(item.serviceCode || '').trim().toUpperCase()}::${item.serviceName.trim().toLowerCase()}`;
    if (!item.serviceCode || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(item);
  }

  if (unique.length >= 3) {
    return unique.slice(0, 3);
  }

  for (const service of services) {
    const key = `${service.code.trim().toUpperCase()}::${service.name.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      serviceCode: service.code,
      serviceName: service.name,
      reasoning:
        service.description?.trim() ||
        `${service.name} is a relevant adjacent service for this client based on the current profile and enrichment context.`,
      priority: unique.length === 0 ? 'high' : unique.length === 1 ? 'medium' : 'low',
    });
    if (unique.length >= 3) break;
  }

  return unique.slice(0, 3);
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: string | null;
}

async function searchClient(query: string): Promise<ClientResearchSource[]> {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey || !query.trim()) {
    return [];
  }

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: 'advanced',
      max_results: 6,
      include_answer: false,
      include_raw_content: false,
    }),
    cache: 'no-store',
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Tavily search failed with ${response.status}: ${detail}`);
  }

  const payload = (await response.json()) as { results?: TavilyResult[] };
  return (payload.results || [])
    .map((item) => ({
      title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : 'Untitled source',
      url: typeof item.url === 'string' ? item.url.trim() : '',
      snippet: typeof item.content === 'string' && item.content.trim() ? item.content.trim() : item.raw_content?.trim() || null,
    }))
    .filter((item) => item.url);
}

export async function enrichClientProfile(input: {
  name: string;
  company?: string | null;
  website?: string | null;
  location?: string | null;
}): Promise<{ summary: string; sources: ClientResearchSource[] }> {
  const query = [input.name, input.company, input.website, input.location].filter(Boolean).join(' ');
  const sources = await searchClient(query);

  if (sources.length === 0) {
    throw new Error('No research sources found for this client.');
  }

  const summary = await generateText({
    preferredProvider: 'openai',
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    temperature: 0.2,
    maxTokens: 600,
    system:
      'You summarize business contacts for an internal workspace. Be concrete, concise, and avoid marketing filler.',
    messages: [
      {
        role: 'user',
        content: `Create a short client enrichment summary for the following profile.

Client:
${JSON.stringify(input, null, 2)}

Sources:
${sources
  .map((source, index) => `[${index + 1}] ${source.title} (${source.url})\n${source.snippet || 'No snippet available.'}`)
  .join('\n\n')}

Return 2 short paragraphs followed by a final line starting with "Suggested next step:".
Focus on who they are, what matters commercially, and what would be useful before the next interaction.`,
      },
    ],
  });

  return { summary, sources };
}

export async function recommendClientServices(input: {
  name: string;
  company?: string | null;
  website?: string | null;
  location?: string | null;
  timezone?: string | null;
  notes?: string | null;
  enrichmentSummary?: string | null;
  services: Array<{
    code: string;
    name: string;
    category: string;
    description?: string | null;
    estimatedDuration?: string | null;
    basePrice?: number | null;
    currency?: string | null;
  }>;
}): Promise<ClientServiceRecommendation[]> {
  if (input.services.length === 0) {
    throw new Error('No active services found. Add services in the Services page first.');
  }

  const text = await generateText({
    preferredProvider: 'openai',
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    temperature: 0.4,
    maxTokens: 900,
    responseMimeType: 'application/json',
    system:
      'You are a practical service strategist. Recommend only from the provided service catalog. Return valid JSON only.',
    messages: [
      {
        role: 'user',
        content: `Recommend 3 service opportunities for this client.

Client:
${JSON.stringify(input, null, 2)}

Constraints:
- Return EXACTLY 3 DISTINCT recommendations.
- You MUST choose from the provided services array only.
- Do not invent a service that is not in the catalog.
- Pick the most commercially relevant options for this specific client.
- Never repeat the same serviceCode or serviceName more than once.

Return JSON with this shape:
{
  "recommendations": [
    {
      "serviceCode": "string",
      "serviceName": "string",
      "reasoning": "string",
      "priority": "high|medium|low"
    }
  ]
}`,
      },
    ],
  });

  const parsed = JSON.parse(text) as { recommendations?: ClientServiceRecommendation[] };
  const valid = (parsed.recommendations || []).filter(
    (item) =>
      item &&
      typeof item.serviceCode === 'string' &&
      typeof item.serviceName === 'string' &&
      typeof item.reasoning === 'string' &&
      (item.priority === 'high' || item.priority === 'medium' || item.priority === 'low')
  );

  return dedupeRecommendations(valid, input.services);
}
