import { URL } from 'node:url';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { buildAgentExecution } from '@/lib/ai/personas';
import { generateJson } from '@/lib/ai/provider';
import type { PersonaIntros, RoutingTask, UserProfile, WorkspaceState, ChatMessage } from '@/lib/ai/types';
import { createGeneratedFileFromBuffer } from '@/lib/generated-files/service';

export interface ResearchPlanSource {
  category: string;
  url: string;
  certainty: 'CERTAIN' | 'UNCERTAIN';
  notes: string;
}

export interface ResearchRetrievalPlan {
  companyName: string;
  ticker: string | null;
  exchange: string | null;
  dateScope: string | null;
  outputDestination: 'google_drive' | 'onedrive' | 'workspace';
  folderName: string;
  filenameConvention: string;
  estimatedTotalDocuments: number | null;
  forbiddenSources: string[];
  notes: string[];
  sources: ResearchPlanSource[];
}

interface ResearchManifestItem {
  filename: string;
  period: string;
  docType: string;
  publicationDate: string;
  sourceUrl: string;
  fileFormat: string;
  subfolder: string;
  category: string;
}

interface ResearchMissingItem {
  category: string;
  period: string;
  docType: string;
  urlsChecked: string[];
  reason: string;
  notes: string;
}

interface ResearchExecutionLogItem {
  category: string;
  requestedUrl: string;
  finalUrl: string | null;
  status: 'retrieved' | 'expanded' | 'missing' | 'error';
  details: string;
  discoveredLinks: string[];
}

interface FetchedResearchResource {
  finalUrl: string;
  contentType: string | null;
  bodyText: string;
  buffer: Buffer;
}

interface TavilySearchResultItem {
  url?: string;
  title?: string;
  content?: string;
}

function normalizePlanSource(item: unknown): ResearchPlanSource | null {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const source = item as Record<string, unknown>;
  const url = typeof source.url === 'string' ? source.url.trim() : '';
  if (!url) {
    return null;
  }

  try {
    const normalizedUrl = new URL(url).toString();
    return {
      category: typeof source.category === 'string' && source.category.trim() ? source.category.trim() : 'Primary source',
      url: normalizedUrl,
      certainty: source.certainty === 'UNCERTAIN' ? 'UNCERTAIN' : 'CERTAIN',
      notes: typeof source.notes === 'string' ? source.notes.trim() : '',
    };
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function sanitizePlan(plan: ResearchRetrievalPlan): ResearchRetrievalPlan {
  return {
    companyName: plan.companyName?.trim() || 'Research mandate',
    ticker: plan.ticker?.trim() || null,
    exchange: plan.exchange?.trim() || null,
    dateScope: plan.dateScope?.trim() || null,
    outputDestination:
      plan.outputDestination === 'google_drive' || plan.outputDestination === 'onedrive' ? plan.outputDestination : 'workspace',
    folderName: plan.folderName?.trim() || `${(plan.ticker || plan.companyName || 'research').replace(/\s+/g, '_')}_Research`,
    filenameConvention: plan.filenameConvention?.trim() || '[TICKER]_[PERIOD]_[DOCTYPE]_[YYYYMMDD].[ext]',
    estimatedTotalDocuments:
      typeof plan.estimatedTotalDocuments === 'number' && Number.isFinite(plan.estimatedTotalDocuments)
        ? plan.estimatedTotalDocuments
        : null,
    forbiddenSources: Array.isArray(plan.forbiddenSources)
      ? plan.forbiddenSources.filter(isNonEmptyString).map((item) => item.trim())
      : [],
    notes: Array.isArray(plan.notes)
      ? plan.notes.filter(isNonEmptyString).map((item) => item.trim())
      : [],
    sources: Array.isArray(plan.sources) ? plan.sources.map(normalizePlanSource).filter((item): item is ResearchPlanSource => Boolean(item)) : [],
  };
}

export function parseResearchPlanText(input: string): ResearchRetrievalPlan {
  const parsed = JSON.parse(input) as ResearchRetrievalPlan;
  return sanitizePlan(parsed);
}

function formatResearchPlan(plan: ResearchRetrievalPlan): string {
  const lines = [
    `## Retrieval Plan: ${plan.companyName}`,
    '',
    `- Ticker: ${plan.ticker || 'Not specified'}`,
    `- Exchange: ${plan.exchange || 'Not specified'}`,
    `- Date scope: ${plan.dateScope || 'Not specified'}`,
    `- Output destination: ${plan.outputDestination}`,
    `- Folder name: ${plan.folderName}`,
    `- Filename convention: ${plan.filenameConvention}`,
    `- Estimated document count: ${plan.estimatedTotalDocuments ?? 'Unknown'}`,
  ];

  if (plan.forbiddenSources.length > 0) {
    lines.push('', `Forbidden sources: ${plan.forbiddenSources.join(', ')}`);
  }

  if (plan.notes.length > 0) {
    lines.push('', 'Notes:', ...plan.notes.map((note) => `- ${note}`));
  }

  lines.push('', '### Planned URLs');
  if (plan.sources.length === 0) {
    lines.push('- No URLs were identified. Reply with corrections before confirming.');
  } else {
    lines.push(
      ...plan.sources.map((source) => `- [${source.certainty}] ${source.category}: ${source.url}${source.notes ? ` — ${source.notes}` : ''}`)
    );
  }

  return lines.join('\n');
}

function escapeCsv(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function filenameFromUrl(url: string, index: number): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    if (last) {
      return last;
    }
  } catch {
    // ignore
  }
  return `document_${index + 1}.html`;
}

/** Standard filename per PROMPT 18: [TICKER]_[PERIOD]_[DOCTYPE]_[YYYYMMDD].[ext] */
function standardFilename(params: {
  ticker: string | null;
  period: string;
  docType: string;
  publicationDate: string;
  ext: string;
  index: number;
}): string {
  const ticker = (params.ticker || 'DOC').replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '');
  const period = params.period.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20) || 'period';
  const docType = params.docType.replace(/\s+/g, '_').slice(0, 24) || 'other';
  const yyyymmdd = params.publicationDate?.replace(/\D/g, '').slice(0, 8) || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${ticker}_${period}_${docType}_${yyyymmdd}.${params.ext}`;
}

function inferFileFormat(url: string, contentType: string | null): string {
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.endsWith('.pdf') || contentType?.includes('pdf')) return 'pdf';
  if (lowerUrl.endsWith('.xlsx') || lowerUrl.endsWith('.xls') || contentType?.includes('spreadsheet')) return 'xlsx';
  if (lowerUrl.endsWith('.docx') || lowerUrl.endsWith('.doc')) return 'docx';
  if (lowerUrl.endsWith('.csv') || contentType?.includes('csv')) return 'csv';
  return 'html';
}

/** Reason values per PROMPT 18 Phase 4: not_published | page_not_found | access_denied | link_broken | date_out_of_scope */
function inferMissingReason(message: string): ResearchMissingItem['reason'] {
  if (/403|forbidden|access denied/i.test(message)) return 'access_denied';
  if (/404|not found/i.test(message)) return 'page_not_found';
  if (/broken|invalid url/i.test(message)) return 'link_broken';
  if (/date|scope|out of range/i.test(message)) return 'date_out_of_scope';
  return 'not_published';
}

function getHostname(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function uniqueUrls(urls: string[]): string[] {
  return [...new Set(urls)];
}

async function searchWithTavily(params: {
  query: string;
  includeDomains?: string[];
}): Promise<string[]> {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) {
    return [];
  }

  console.info('[research] tavily search start', {
    query: params.query,
    includeDomains: params.includeDomains || [],
  });

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: params.query,
      topic: 'finance',
      search_depth: 'advanced',
      max_results: 8,
      include_answer: false,
      include_raw_content: false,
      include_domains: params.includeDomains && params.includeDomains.length > 0 ? params.includeDomains : undefined,
    }),
    cache: 'no-store',
  });

  if (!response.ok) {
    const detail = await response.text();
    console.warn('[research] tavily search failed', {
      query: params.query,
      status: response.status,
      detail,
    });
    return [];
  }

  const payload = (await response.json()) as { results?: TavilySearchResultItem[] };
  const urls = (payload.results || [])
    .map((item) => (typeof item.url === 'string' ? item.url.trim() : ''))
    .filter(Boolean);

  console.info('[research] tavily search result', {
    query: params.query,
    resultCount: urls.length,
  });

  return uniqueUrls(urls);
}

/** doc_type per PROMPT 18 Phase 4: annual_report | interim_results | full_year_results | sgx_announcement | agm_notice | ... | other */
function mapCategoryToDocType(category: string): string {
  const lower = category.toLowerCase();
  if (lower.includes('annual')) return 'annual_report';
  if (lower.includes('interim')) return 'interim_results';
  if (lower.includes('full year') || lower.includes('fy')) return 'full_year_results';
  if (lower.includes('sgx') || lower.includes('announcement') || lower.includes('exchange')) return 'sgx_announcement';
  if (lower.includes('agm') || lower.includes('egm')) return 'agm_notice';
  if (lower.includes('sustain')) return 'sustainability_report';
  if (lower.includes('earnings') || lower.includes('release') || lower.includes('8-k')) return 'earnings_release';
  if (lower.includes('investor') && lower.includes('presentation')) return 'investor_presentation';
  if (lower.includes('webcast') || lower.includes('transcript')) return 'webcast_transcript';
  if (lower.includes('dividend')) return 'dividend_announcement';
  if (lower.includes('buyback')) return 'buyback_announcement';
  if (lower.includes('debt') || lower.includes('bond')) return 'debt_announcement';
  if (lower.includes('m&a') || lower.includes('acquisition') || lower.includes('disposal')) return 'ma_announcement';
  if (lower.includes('profit') && lower.includes('warn')) return 'profit_warning';
  if (lower.includes('sgx') && lower.includes('query')) return 'sgx_query';
  return 'other';
}

/** Standard folder structure per PROMPT 18 Phase 1 */
function mapCategoryToSubfolder(category: string): string {
  const lower = category.toLowerCase();
  if (lower.includes('annual')) return '01_Annual_Reports';
  if (lower.includes('interim')) return '02_Interim_Results';
  if (lower.includes('full year') || lower.includes('fy')) return '03_Full_Year_Results';
  if (lower.includes('announcement') || lower.includes('exchange') || lower.includes('sgx')) return '04_SGX_Announcements';
  if (lower.includes('agm') || lower.includes('egm')) return '05_AGM_EGM';
  if (lower.includes('sustain')) return '06_Sustainability';
  return '07_Other';
}

function isLikelyDocumentLink(url: string): boolean {
  return /\.(pdf|xlsx?|docx?|csv)(?:$|[?#])/i.test(url);
}

function isLikelyRelevantHtmlLink(url: string): boolean {
  return /(investor|announcement|results|report|annual|interim|sustain|agm|egm|financial|filing)/i.test(url);
}

function extractLinksFromHtml(html: string, baseUrl: string): string[] {
  const matches = html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi);
  const links = new Set<string>();

  for (const match of matches) {
    const raw = match[1]?.trim();
    if (!raw) {
      continue;
    }
    try {
      const absolute = new URL(raw, baseUrl).toString();
      if (absolute.startsWith('http://') || absolute.startsWith('https://')) {
        links.add(absolute);
      }
    } catch {
      // ignore malformed URLs
    }
  }

  return [...links];
}

async function fetchResearchUrl(url: string, referer?: string | null): Promise<FetchedResearchResource> {
  const attempts: Array<{ label: string; headers: Record<string, string> }> = [
    {
      label: 'browser-like',
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        referer: referer || new URL(url).origin,
        dnt: '1',
        'upgrade-insecure-requests': '1',
      },
    },
    {
      label: 'minimal',
      headers: {
        'user-agent': 'ClientFlowResearchBot/1.0 (+https://client-flow-orchestrator.babalilm-ai.com)',
        accept: '*/*',
        referer: referer || new URL(url).origin,
      },
    },
  ];

  let lastError: Error | null = null;

  const timeoutMs = 90_000;
  for (const attempt of attempts) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      console.info('[research] fetch start', { url, attempt: attempt.label, referer: attempt.headers.referer });
      const response = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: attempt.headers,
        cache: 'no-store',
      });

      const finalUrl = response.url || url;
      const contentType = response.headers.get('content-type');
      const buffer = Buffer.from(await response.arrayBuffer());
      const bodyText = /text|json|xml|html/i.test(contentType || '') ? buffer.toString('utf8') : '';

      console.info('[research] fetch result', {
        url,
        attempt: attempt.label,
        status: response.status,
        finalUrl,
        contentType,
        bytes: buffer.byteLength,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return {
        finalUrl,
        contentType,
        bodyText,
        buffer,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn('[research] fetch failed', {
        url,
        attempt: attempt.label,
        error: lastError.message,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error('Fetch failed');
}

function buildManifestCsv(items: ResearchManifestItem[]): string {
  const rows = [
    'filename,period,doc_type,publication_date,source_url,file_format,subfolder',
    ...items.map((item) =>
      [
        escapeCsv(item.filename),
        escapeCsv(item.period),
        escapeCsv(item.docType),
        escapeCsv(item.publicationDate),
        escapeCsv(item.sourceUrl),
        escapeCsv(item.fileFormat),
        escapeCsv(item.subfolder),
      ].join(',')
    ),
  ];

  return rows.join('\n');
}

function buildMissingItemsLog(items: ResearchMissingItem[]): string {
  if (items.length === 0) {
    return 'No missing items recorded.';
  }

  return items
    .map(
      (item, index) =>
        [
          `MISSING ITEM ${index + 1}`,
          `Category: ${item.category}`,
          `Period: ${item.period}`,
          `Doc Type: ${item.docType}`,
          `URLs Checked: ${item.urlsChecked.join(', ') || 'None'}`,
          `Reason: ${item.reason}`,
          `Notes: ${item.notes || 'None'}`,
        ].join('\n')
    )
    .join('\n\n');
}

function buildExecutionLog(logItems: ResearchExecutionLogItem[]): string {
  if (logItems.length === 0) {
    return 'No execution log entries recorded.';
  }

  return logItems
    .map((item, index) =>
      [
        `ENTRY ${index + 1}`,
        `Category: ${item.category}`,
        `Requested URL: ${item.requestedUrl}`,
        `Final URL: ${item.finalUrl || 'None'}`,
        `Status: ${item.status}`,
        `Details: ${item.details}`,
        `Discovered Links: ${item.discoveredLinks.join(', ') || 'None'}`,
      ].join('\n')
    )
    .join('\n\n')
    .trim();
}

/** Phase 6 completion summary as markdown (file form). The deliverable is the document collection; this file is the summary only. */
function buildCompletionSummaryMarkdown(
  plan: ResearchRetrievalPlan,
  manifestItems: ResearchManifestItem[],
  missingItems: ResearchMissingItem[],
  downloadedFiles: Array<{ title: string; openUrl: string }> = []
): string {
  const categories = new Map<string, { retrieved: number; missing: number }>();

  for (const item of manifestItems) {
    const current = categories.get(item.category) || { retrieved: 0, missing: 0 };
    current.retrieved += 1;
    categories.set(item.category, current);
  }

  for (const item of missingItems) {
    const current = categories.get(item.category) || { retrieved: 0, missing: 0 };
    current.missing += 1;
    categories.set(item.category, current);
  }

  const total = manifestItems.length + missingItems.length;
  const pct = total > 0 ? Math.round((manifestItems.length / total) * 100) : 0;
  const dest =
    plan.outputDestination === 'google_drive' ? 'Google Drive' : plan.outputDestination === 'onedrive' ? 'OneDrive' : 'Workspace';

  const lines = [
    `# Research Report — ${plan.companyName}${plan.ticker ? ` (${plan.ticker})` : ''}`,
    '',
    `Root folder:        ${plan.folderName} in ${dest}`,
    `Total documents:    ${total}`,
    `Retrieved:          ${manifestItems.length} (${pct}%)`,
    `Missing:            ${missingItems.length} — see missing_items.txt`,
    '',
    'BY CATEGORY:',
    '| Category | Retrieved | Missing |',
    '|----------|-----------|---------|',
    ...[...categories.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([cat, counts]) => `| ${cat} | ${counts.retrieved} | ${counts.missing} |`),
    '',
    'manifest.csv and missing_items.txt uploaded to root folder.',
    ...(downloadedFiles.length > 0 ? ['', 'Documents in collection:', ...downloadedFiles.map((f) => `- ${f.title}`)] : []),
  ];

  return lines.join('\n');
}

/** Build Phase 6 COMPLETION REPORT. Primary deliverable is the ZIP (no Drive/OneDrive); PDF and links also available. */
function buildCompletionReportMessage(params: {
  plan: ResearchRetrievalPlan;
  manifestItems: ResearchManifestItem[];
  missingItems: ResearchMissingItem[];
  downloadedFiles: Array<{ title: string; openUrl: string }>;
  zipFileUrl: string;
  reportFileUrl: string;
  manifestFileUrl: string;
  missingFileUrl: string;
  logFileUrl: string;
  pdfFileUrl: string;
}): string {
  const categories = new Map<string, { retrieved: number; missing: number }>();

  for (const item of params.manifestItems) {
    const current = categories.get(item.category) || { retrieved: 0, missing: 0 };
    current.retrieved += 1;
    categories.set(item.category, current);
  }

  for (const item of params.missingItems) {
    const current = categories.get(item.category) || { retrieved: 0, missing: 0 };
    current.missing += 1;
    categories.set(item.category, current);
  }

  const total = params.manifestItems.length + params.missingItems.length;
  const pct = total > 0 ? Math.round((params.manifestItems.length / total) * 100) : 0;
  const tickerPart = params.plan.ticker ? ` (${params.plan.ticker})` : '';

  const categoryRows = [...categories.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cat, counts]) => `| ${cat} | ${counts.retrieved} | ${counts.missing} |`);

  const block = [
    `Research completed for **${params.plan.companyName}**${tickerPart}.`,
    '',
    `Total: ${total} documents — ${params.manifestItems.length} retrieved (${pct}%), ${params.missingItems.length} missing.`,
    '',
    '**By category:**',
    '',
    '| Category | Retrieved | Missing |',
    '|----------|-----------|---------|',
    ...categoryRows,
    '',
    `**Download:** [Document collection (ZIP)](${params.zipFileUrl}) — Research Report PDF and all retrieved documents.`,
    '',
    `Or [Research Report (PDF)](${params.pdfFileUrl}) only.`,
    ...(params.downloadedFiles.length > 0
      ? ['', '**Documents:**', ...params.downloadedFiles.slice(0, 12).map((f) => `- [${f.title}](${f.openUrl})`)]
      : []),
    '',
  ].join('\n');

  return block;
}

/** Full Research Report PDF per Phase 6: title, summary, BY CATEGORY, retrieved documents, missing items. */
async function buildResearchReportPdf(params: {
  plan: ResearchRetrievalPlan;
  manifestItems: ResearchManifestItem[];
  missingItems: ResearchMissingItem[];
  logItems: ResearchExecutionLogItem[];
  downloadedCount: number;
}): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const width = 612;
  const height = 792;
  const margin = 50;
  const lineHeight = 14;
  const maxCharsPerLine = 85;

  let page = pdf.addPage([612, 792]);
  let y = height - margin;

  const wrap = (text: string): string[] => {
    const out: string[] = [];
    let rest = text;
    while (rest.length > maxCharsPerLine) {
      const chunk = rest.slice(0, maxCharsPerLine);
      const lastSpace = chunk.lastIndexOf(' ');
      const cut = lastSpace > 40 ? lastSpace : maxCharsPerLine;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out;
  };

  const writeLine = (text: string, opts?: { bold?: boolean; size?: number }) => {
    const size = opts?.size ?? 11;
    const f = opts?.bold ? bold : font;
    for (const line of wrap(text)) {
      if (y < margin + lineHeight) {
        page = pdf.addPage([612, 792]);
        y = height - margin;
      }
      page.drawText(line.slice(0, 120), { x: margin, y, size, font: f, maxWidth: width - margin * 2 });
      y -= lineHeight;
    }
  };

  const total = params.manifestItems.length + params.missingItems.length;
  const pct = total > 0 ? Math.round((params.manifestItems.length / total) * 100) : 0;
  const dest =
    params.plan.outputDestination === 'workspace'
      ? 'Workspace'
      : params.plan.outputDestination === 'google_drive'
        ? 'Google Drive'
        : 'OneDrive';
  const tickerPart = params.plan.ticker ? ` (${params.plan.ticker})` : '';

  writeLine('RESEARCH REPORT', { bold: true, size: 18 });
  writeLine(`${params.plan.companyName}${tickerPart}`, { bold: true, size: 14 });
  y -= 8;
  writeLine('Root folder: ' + params.plan.folderName + ' in ' + dest);
  writeLine(`Total documents: ${total}  |  Retrieved: ${params.manifestItems.length} (${pct}%)  |  Missing: ${params.missingItems.length}`);
  y -= 12;
  writeLine('BY CATEGORY', { bold: true });
  const categories = new Map<string, { retrieved: number; missing: number }>();
  for (const item of params.manifestItems) {
    const c = categories.get(item.category) || { retrieved: 0, missing: 0 };
    c.retrieved += 1;
    categories.set(item.category, c);
  }
  for (const item of params.missingItems) {
    const c = categories.get(item.category) || { retrieved: 0, missing: 0 };
    c.missing += 1;
    categories.set(item.category, c);
  }
  for (const [cat, counts] of [...categories.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    writeLine(`  ${cat}: Retrieved ${counts.retrieved}, Missing ${counts.missing}`);
  }
  y -= 16;
  writeLine('Retrieved documents', { bold: true });
  params.manifestItems.forEach((item) => {
    writeLine(`  • ${item.filename}  (${item.category})`);
  });
  if (params.missingItems.length > 0) {
    y -= 8;
    writeLine('Missing items', { bold: true });
    params.missingItems.forEach((item) => {
      writeLine(`  • ${item.category}: ${item.reason} — ${(item.urlsChecked[0] || '').slice(0, 50)}`);
    });
  }
  writeLine('');
  writeLine('manifest.csv and missing_items.txt are in the root folder. See workspace links in the assistant for supporting files.');

  return Buffer.from(await pdf.save());
}

export async function buildResearchRetrievalPlan(params: {
  task: RoutingTask;
  history: ChatMessage[];
  profile: UserProfile;
  intros: PersonaIntros;
  workspace: WorkspaceState;
}): Promise<ResearchRetrievalPlan> {
  const execution = await buildAgentExecution('RESEARCH_AGENT', params.task, params.intros, params.profile, params.history, params.workspace, []);
  const plan = await generateJson<ResearchRetrievalPlan>({
    system: [
      execution.system,
      'PHASE OVERRIDE: stop after PHASE 2. Produce only the retrieval plan. Do not fetch any URLs. Do not produce a completion report. Return valid JSON only.',
    ]
      .filter(Boolean)
      .join('\n\n'),
    messages: [
      ...execution.messages,
      {
        role: 'user',
        content: [
          'Return only the retrieval plan as JSON with this exact shape:',
          '{',
          '  "companyName": "string",',
          '  "ticker": "string | null",',
          '  "exchange": "string | null",',
          '  "dateScope": "string | null",',
          '  "outputDestination": "google_drive | onedrive | workspace",',
          '  "folderName": "string",',
          '  "filenameConvention": "string",',
          '  "estimatedTotalDocuments": number | null,',
          '  "forbiddenSources": ["string"],',
          '  "notes": ["string"],',
          '  "sources": [',
          '    {',
          '      "category": "string",',
          '      "url": "https://...",',
          '      "certainty": "CERTAIN | UNCERTAIN",',
          '      "notes": "string"',
          '    }',
          '  ]',
          '}',
          'Use named primary-source URLs only.',
        ].join('\n'),
      },
    ],
    maxTokens: 1_800,
    temperature: 0.1,
    preferredProvider: 'anthropic',
    model: execution.model,
  });

  return sanitizePlan(plan);
}

export async function executeResearchRetrievalPlan(params: {
  userId: string;
  projectId?: string | null;
  plan: ResearchRetrievalPlan;
}): Promise<{ message: string; payloadPatch: Record<string, unknown> }> {
  console.info('[research] execution start', {
    company: params.plan.companyName,
    projectId: params.projectId || null,
    sourceCount: params.plan.sources.length,
    destination: params.plan.outputDestination,
  });
  const manifestItems: ResearchManifestItem[] = [];
  const missingItems: ResearchMissingItem[] = [];
  const logItems: ResearchExecutionLogItem[] = [];
  const seen = new Set<string>();
  const downloadedFiles: Array<{ title: string; openUrl: string; fileId: string }> = [];
  const zipEntries: Array<{ zipPath: string; buffer: Buffer }> = [];
  const tavilyFallbackHits: Array<{ category: string; urls: string[] }> = [];

  const usedFilenames = new Set<string>();
  const storeDownloadedResource = async (resourceUrl: string, source: ResearchPlanSource, referer?: string | null) => {
    const fetched = await fetchResearchUrl(resourceUrl, referer);
    const fileFormat = inferFileFormat(fetched.finalUrl, fetched.contentType);
    const docType = mapCategoryToDocType(source.category);
    const period = params.plan.dateScope || 'unknown';
    let fileName = standardFilename({
      ticker: params.plan.ticker,
      period,
      docType,
      publicationDate: '',
      ext: fileFormat === 'xlsx' ? 'xlsx' : fileFormat === 'pdf' ? 'pdf' : fileFormat === 'docx' ? 'docx' : 'html',
      index: manifestItems.length,
    });
    let n = 1;
    while (usedFilenames.has(fileName)) {
      const base = fileName.replace(/\.[^.]+$/, '');
      const ext = fileName.includes('.') ? fileName.split('.').pop()! : 'pdf';
      fileName = `${base}_${++n}.${ext}`;
    }
    usedFilenames.add(fileName);
    const saved = await createGeneratedFileFromBuffer({
      userId: params.userId,
      projectId: params.projectId || null,
      title: `${params.plan.folderName} — ${mapCategoryToSubfolder(source.category)} — ${fileName}`,
      fileName,
      mimeType:
        fetched.contentType ||
        (fileFormat === 'pdf'
          ? 'application/pdf'
          : fileFormat === 'xlsx'
            ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            : 'text/html'),
      buffer: fetched.buffer,
    });

    const subfolder = mapCategoryToSubfolder(source.category);
    manifestItems.push({
      filename: fileName,
      period,
      docType,
      publicationDate: '',
      sourceUrl: fetched.finalUrl,
      fileFormat,
      subfolder,
      category: source.category,
    });
    downloadedFiles.push({ title: fileName, openUrl: saved.openUrl, fileId: saved.fileId });
    zipEntries.push({ zipPath: `${subfolder}/${fileName}`, buffer: fetched.buffer });
    return fetched;
  };

  for (const source of params.plan.sources.slice(0, 12)) {
    try {
      const fetched = await fetchResearchUrl(source.url);
      const fileFormat = inferFileFormat(fetched.finalUrl, fetched.contentType);

      if (fileFormat !== 'html' || isLikelyDocumentLink(fetched.finalUrl)) {
        if (!seen.has(fetched.finalUrl)) {
          seen.add(fetched.finalUrl);
          await storeDownloadedResource(fetched.finalUrl, source, source.url);
        }
        logItems.push({
          category: source.category,
          requestedUrl: source.url,
          finalUrl: fetched.finalUrl,
          status: 'retrieved',
          details: `Direct ${fileFormat.toUpperCase()} or document link recorded.`,
          discoveredLinks: [],
        });
        continue;
      }

      const links = extractLinksFromHtml(fetched.bodyText, fetched.finalUrl).filter(
        (link) => isLikelyDocumentLink(link) || isLikelyRelevantHtmlLink(link)
      );

      const selected = links.slice(0, 12);
      if (selected.length === 0) {
        const sourceHost = getHostname(source.url);
        const tavilyResults = await searchWithTavily({
          query: `${params.plan.companyName} ${source.category} primary source filetype:pdf`,
          includeDomains: sourceHost ? [sourceHost] : [],
        });

        if (tavilyResults.length === 0) {
          missingItems.push({
            category: source.category,
            period: params.plan.dateScope || 'unknown',
            docType: mapCategoryToDocType(source.category),
            urlsChecked: [source.url],
            reason: source.certainty === 'CERTAIN' ? 'not_published' : 'not_published',
            notes: source.notes || 'No relevant document links were found on the page.',
          });
          logItems.push({
            category: source.category,
            requestedUrl: source.url,
            finalUrl: fetched.finalUrl,
            status: 'missing',
            details: 'Fetched page but found no relevant document links.',
            discoveredLinks: [],
          });
          continue;
        }

        tavilyFallbackHits.push({ category: source.category, urls: tavilyResults.slice(0, 4) });
        for (const link of tavilyResults.slice(0, 4)) {
          if (seen.has(link)) continue;
          seen.add(link);
          const discoveredFormat = inferFileFormat(link, null);
          if (discoveredFormat === 'html') {
            manifestItems.push({
              filename: filenameFromUrl(link, manifestItems.length),
              period: params.plan.dateScope || 'unknown',
              docType: mapCategoryToDocType(source.category),
              publicationDate: '',
              sourceUrl: link,
              fileFormat: 'html',
              subfolder: mapCategoryToSubfolder(source.category),
              category: source.category,
            });
          } else {
            try {
              await storeDownloadedResource(link, source, fetched.finalUrl);
            } catch {
              manifestItems.push({
                filename: filenameFromUrl(link, manifestItems.length),
                period: params.plan.dateScope || 'unknown',
                docType: mapCategoryToDocType(source.category),
                publicationDate: '',
                sourceUrl: link,
                fileFormat: discoveredFormat,
                subfolder: mapCategoryToSubfolder(source.category),
                category: source.category,
              });
            }
          }
        }
        logItems.push({
          category: source.category,
          requestedUrl: source.url,
          finalUrl: fetched.finalUrl,
          status: 'expanded',
          details: `Expanded HTML page had no direct links. Tavily fallback found ${tavilyResults.length} primary-source candidates.`,
          discoveredLinks: tavilyResults.slice(0, 6),
        });
        continue;
      }

      for (const link of selected) {
        if (seen.has(link)) {
          continue;
        }
        seen.add(link);
        const discoveredFormat = inferFileFormat(link, null);
        if (discoveredFormat === 'html') {
          manifestItems.push({
            filename: filenameFromUrl(link, manifestItems.length),
            period: params.plan.dateScope || 'unknown',
            docType: mapCategoryToDocType(source.category),
            publicationDate: '',
            sourceUrl: link,
            fileFormat: 'html',
            subfolder: mapCategoryToSubfolder(source.category),
            category: source.category,
          });
        } else {
          try {
            await storeDownloadedResource(link, source, fetched.finalUrl);
          } catch (downloadError) {
            missingItems.push({
              category: source.category,
              period: params.plan.dateScope || 'unknown',
              docType: mapCategoryToDocType(source.category),
              urlsChecked: [source.url, link],
              reason: inferMissingReason(downloadError instanceof Error ? downloadError.message : String(downloadError)),
              notes: downloadError instanceof Error ? downloadError.message : 'Document download failed',
            });
          }
        }
      }
      logItems.push({
        category: source.category,
        requestedUrl: source.url,
        finalUrl: fetched.finalUrl,
        status: 'expanded',
        details: `Expanded HTML page and recorded ${selected.length} candidate links.`,
        discoveredLinks: selected.slice(0, 6),
      });
    } catch (error) {
      console.error('[research] source failed', {
        category: source.category,
        url: source.url,
        error: error instanceof Error ? error.message : String(error),
      });
      const sourceHost = getHostname(source.url);
      const tavilyResults = await searchWithTavily({
        query: `${params.plan.companyName} ${source.category} primary source`,
        includeDomains: sourceHost ? [sourceHost] : [],
      });

      if (tavilyResults.length > 0) {
        tavilyFallbackHits.push({ category: source.category, urls: tavilyResults.slice(0, 6) });
        let downloadedFromTavily = 0;
        for (const link of tavilyResults.slice(0, 6)) {
          if (seen.has(link)) continue;
          seen.add(link);
          try {
            const fetched = await fetchResearchUrl(link);
            const fileFormat = inferFileFormat(fetched.finalUrl, fetched.contentType);
            if (fileFormat !== 'html' || isLikelyDocumentLink(fetched.finalUrl)) {
              await storeDownloadedResource(fetched.finalUrl, source, link);
              downloadedFromTavily += 1;
            } else {
              manifestItems.push({
                filename: filenameFromUrl(fetched.finalUrl, manifestItems.length),
                period: params.plan.dateScope || 'unknown',
                docType: mapCategoryToDocType(source.category),
                publicationDate: '',
                sourceUrl: fetched.finalUrl,
                fileFormat: 'html',
                subfolder: mapCategoryToSubfolder(source.category),
                category: source.category,
              });
            }
          } catch {
            manifestItems.push({
              filename: filenameFromUrl(link, manifestItems.length),
              period: params.plan.dateScope || 'unknown',
              docType: mapCategoryToDocType(source.category),
              publicationDate: '',
              sourceUrl: link,
              fileFormat: inferFileFormat(link, null),
              subfolder: mapCategoryToSubfolder(source.category),
              category: source.category,
            });
          }
        }
        logItems.push({
          category: source.category,
          requestedUrl: source.url,
          finalUrl: null,
          status: 'expanded',
          details: `Direct fetch failed (${error instanceof Error ? error.message : 'Fetch failed'}). Tavily fallback: ${tavilyResults.length} candidates, ${downloadedFromTavily} downloaded.`,
          discoveredLinks: tavilyResults.slice(0, 6),
        });
      } else {
        missingItems.push({
          category: source.category,
          period: params.plan.dateScope || 'unknown',
          docType: mapCategoryToDocType(source.category),
          urlsChecked: [source.url],
          reason: inferMissingReason(error instanceof Error ? error.message : String(error)),
          notes: error instanceof Error ? error.message : 'Fetch failed',
        });
        logItems.push({
          category: source.category,
          requestedUrl: source.url,
          finalUrl: null,
          status: 'error',
          details: error instanceof Error ? error.message : 'Fetch failed',
          discoveredLinks: [],
        });
      }
    }
  }

  const manifestCsv = buildManifestCsv(manifestItems);
  const missingItemsLog = buildMissingItemsLog(missingItems);
  const executionLog = buildExecutionLog(logItems);
  const completionSummaryMd = buildCompletionSummaryMarkdown(params.plan, manifestItems, missingItems, downloadedFiles);
  const completionSummaryPdf = await buildResearchReportPdf({
    plan: params.plan,
    manifestItems,
    missingItems,
    logItems,
    downloadedCount: downloadedFiles.length,
  });

  const researchReportPdfTitle = `Research Report — ${params.plan.companyName}`;
  const researchReportPdfFileName = `Research_Report_${(params.plan.ticker || params.plan.companyName).replace(/\s+/g, '_')}.pdf`;

  const [manifestFile, missingFile, summaryMdFile, logFile, researchReportPdfFile] = await Promise.all([
    createGeneratedFileFromBuffer({
      userId: params.userId,
      projectId: params.projectId || null,
      title: `${params.plan.folderName} — manifest.csv`,
      fileName: `${params.plan.folderName}_manifest.csv`,
      mimeType: 'text/csv',
      buffer: Buffer.from(manifestCsv, 'utf8'),
    }),
    createGeneratedFileFromBuffer({
      userId: params.userId,
      projectId: params.projectId || null,
      title: `${params.plan.folderName} — missing_items.txt`,
      fileName: `${params.plan.folderName}_missing_items.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from(missingItemsLog, 'utf8'),
    }),
    createGeneratedFileFromBuffer({
      userId: params.userId,
      projectId: params.projectId || null,
      title: `${researchReportPdfTitle} (Markdown)`,
      fileName: `${params.plan.folderName}_research_report.md`,
      mimeType: 'text/markdown',
      buffer: Buffer.from(completionSummaryMd, 'utf8'),
    }),
    createGeneratedFileFromBuffer({
      userId: params.userId,
      projectId: params.projectId || null,
      title: `${params.plan.folderName} — execution_log.txt`,
      fileName: `${params.plan.folderName}_execution_log.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from(executionLog, 'utf8'),
    }),
    createGeneratedFileFromBuffer({
      userId: params.userId,
      projectId: params.projectId || null,
      title: researchReportPdfTitle,
      fileName: researchReportPdfFileName,
      mimeType: 'application/pdf',
      buffer: completionSummaryPdf,
    }),
  ]);

  const zip = new JSZip();
  zip.file(researchReportPdfFileName, completionSummaryPdf, { binary: true });
  for (const entry of zipEntries) {
    zip.file(entry.zipPath, entry.buffer, { binary: true });
  }
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  const zipFileName = `Research_${(params.plan.ticker || params.plan.companyName).replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.zip`;
  const zipFile = await createGeneratedFileFromBuffer({
    userId: params.userId,
    projectId: params.projectId || null,
    title: `Document collection — ${params.plan.companyName}`,
    fileName: zipFileName,
    mimeType: 'application/zip',
    buffer: zipBuffer,
  });

  console.info('[research] execution complete', {
    company: params.plan.companyName,
    retrievedCount: manifestItems.length,
    missingCount: missingItems.length,
    downloadedCount: downloadedFiles.length,
  });

  const message = buildCompletionReportMessage({
    plan: params.plan,
    manifestItems,
    missingItems,
    downloadedFiles,
    zipFileUrl: zipFile.openUrl,
    reportFileUrl: summaryMdFile.openUrl,
    manifestFileUrl: manifestFile.openUrl,
    missingFileUrl: missingFile.openUrl,
    logFileUrl: logFile.openUrl,
    pdfFileUrl: researchReportPdfFile.openUrl,
  });

  return {
    message,
    payloadPatch: {
      workflow: 'research_fetch',
      research_completed_at: new Date().toISOString(),
      research_zip_file_id: zipFile.fileId,
      research_report_pdf_file_id: researchReportPdfFile.fileId,
      research_report_file_id: summaryMdFile.fileId,
      research_manifest_file_id: manifestFile.fileId,
      research_missing_file_id: missingFile.fileId,
      research_log_file_id: logFile.fileId,
      retrieved_count: manifestItems.length,
      missing_count: missingItems.length,
    },
  };
}

export function isResearchPlanApprovalPayload(value: unknown): value is { workflow: 'research_fetch'; research_plan: ResearchRetrievalPlan } {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const payload = value as Record<string, unknown>;
  return payload.workflow === 'research_fetch' && payload.research_plan != null;
}

export function formatResearchPlanForReply(plan: ResearchRetrievalPlan): string {
  return `${formatResearchPlan(plan)}\n\nConfirm & fetch is queued in approvals. If you want to revise the plan, reply with corrections before approving it.`;
}
