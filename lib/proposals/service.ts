import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { generateJson } from '@/lib/ai/provider';
import type { UserProfile } from '@/lib/ai/types';
import type { ProposalBullet, ProposalDocumentData, ProposalTable, StoredProposalRecord } from '@/lib/proposals/types';

const execFileAsync = promisify(execFile);
const OUTPUT_DIR = path.join(process.cwd(), 'output', 'pdf');
const TMP_DIR = path.join(process.cwd(), 'tmp', 'pdfs');
const RENDER_SCRIPT = path.join(process.cwd(), 'scripts', 'render_proposal_pdf.py');

function getPythonBin(): string {
  if (process.env.PYTHON_BIN && process.env.PYTHON_BIN.trim()) {
    return process.env.PYTHON_BIN.trim();
  }
  const venvPython = path.join(process.cwd(), '.venv', 'bin', 'python');
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  return 'python3';
}
const PROPOSAL_TABLE = 'assistant_generated_proposals';
const CLAUDE_PROVIDER = 'anthropic' as const;

interface ProposalGenerationInput {
  userId: string;
  preparedByName: string;
  preparedByEmail: string | null;
  firmProfile: UserProfile;
  originalPrompt: string;
  proposalDraft: string;
  companyName: string;
}

interface ProposalRouteResult {
  proposalId: string;
  title: string;
  openUrl: string;
}

type ProposalProgressReporter = (message: string) => Promise<void> | void;

function ensureDirs() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

async function ensureTable() {
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${PROPOSAL_TABLE} (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      pdf_path TEXT NOT NULL,
      json_path TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  );
  await db.query(`ALTER TABLE ${PROPOSAL_TABLE} ADD COLUMN IF NOT EXISTS pdf_data BYTEA`);
  await db.query(`ALTER TABLE ${PROPOSAL_TABLE} ADD COLUMN IF NOT EXISTS json_payload JSONB`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_${PROPOSAL_TABLE}_user_created ON ${PROPOSAL_TABLE} (user_id, created_at DESC)`);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function sanitizeLine(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeTable(table: ProposalTable | undefined, fallbackHeaders: string[]): ProposalTable {
  const headers = Array.isArray(table?.headers) && table.headers.length === fallbackHeaders.length ? table.headers.slice(0, fallbackHeaders.length) : fallbackHeaders;
  const rows = Array.isArray(table?.rows)
    ? table.rows
        .filter((row) => Array.isArray(row) && row.length >= fallbackHeaders.length)
        .map((row) => row.slice(0, fallbackHeaders.length).map((cell) => sanitizeLine(String(cell ?? ''), 'TBD')))
    : [];
  return { headers, rows };
}

function normalizeBullets(items: ProposalBullet[] | undefined, minimum = 1): ProposalBullet[] {
  const normalized = Array.isArray(items)
    ? items
        .filter((item) => item && (item.title || item.detail))
        .map((item) => ({
          title: sanitizeLine(String(item.title ?? ''), 'Key point'),
          detail: sanitizeLine(String(item.detail ?? ''), 'Details to be confirmed during discovery.'),
        }))
    : [];

  if (normalized.length >= minimum) {
    return normalized;
  }

  return [
    {
      title: 'Detailed scoping required',
      detail: 'Specific items will be finalized during discovery based on process walkthroughs and data review.',
    },
  ];
}

function normalizeParagraphs(values: string[] | undefined, fallback: string): string[] {
  const normalized = Array.isArray(values)
    ? values.map((value) => sanitizeLine(String(value ?? ''), '')).filter(Boolean)
    : [];
  return normalized.length ? normalized : [fallback];
}

function buildProposalJsonSystemPrompt(input: ProposalGenerationInput): string {
  return `You are a senior proposal architect. Convert the provided consulting proposal draft into a strict JSON structure for a fixed Bab Al Ilm AI PDF template.

The template is visually fixed and always uses this structure:
1. Executive Summary
2. The Challenge
3. Proposed Solution
3.1 Solution Overview
3.2 Key Capabilities
3.3 Workflow Transformation
4. Technical Approach
4.1 Integration Architecture
4.2 Implementation Workflow
4.3 Security Controls
5. Implementation Roadmap
6. Investment Overview
7. Why ${input.firmProfile.firm_name || 'Our Team'}
8. Next Steps

Requirements:
- Use only valid JSON. No markdown, no commentary.
- Make every section specific to ${input.companyName}.
- The solution must focus on inventory insights, dashboarding, reorder automation, inventory forecasting, purchase planning, and financial reporting when supported by the prompt.
- Use the current-state workflow and pain points from the prompt.
- Tables must be concrete and decision-useful, not generic filler.
- Use ranges and clearly stated assumptions where pricing or timing is estimated.
- Keep text polished, executive-ready, and detailed.
- Keep each narrative paragraph to 2-4 sentences.
- Keep each bullet detail concise and specific, ideally under 90 words.
- Keep tables to the most decision-useful 4-6 rows unless more are essential.
- Do not mention Azure or Power BI unless the prompt actually calls for them.
- Do not invent fake credentials, clients, or software beyond reasonable assumptions.
- Assume Bab Al Ilm AI is the proposing firm.

Return exactly this JSON schema:
{
  "solutionName": "",
  "solutionSubtitle": "",
  "executiveSummary": ["paragraph", "paragraph"],
  "challengeIntro": "",
  "challengePoints": [{"title": "", "detail": ""}],
  "solutionOverview": ["paragraph", "paragraph"],
  "architectureTable": {
    "headers": ["Layer", "Components", "Function"],
    "rows": [["", "", ""]]
  },
  "keyCapabilities": [{"title": "", "detail": ""}],
  "workflowTransformationTitle": "",
  "workflowTransformationIntro": "",
  "workflowTable": {
    "headers": ["Current Workflow", "Automated Future State", "Business Impact"],
    "rows": [["", "", ""]]
  },
  "technicalApproachTitle": "",
  "integrationTable": {
    "headers": ["Workstream", "Approach", "Output"],
    "rows": [["", "", ""]]
  },
  "implementationSteps": ["", ""],
  "securityControls": [{"title": "", "detail": ""}],
  "roadmapIntro": "",
  "roadmapTable": {
    "headers": ["Phase", "Scope", "Deliverables", "Duration"],
    "rows": [["", "", "", ""]]
  },
  "roadmapNote": "",
  "investmentIntro": "",
  "investmentTable": {
    "headers": ["Component", "Estimated Range", "Billing Model"],
    "rows": [["", "", ""]]
  },
  "investmentNote": "",
  "whyUs": [{"title": "", "detail": ""}],
  "nextStepsIntro": "",
  "nextSteps": ["", ""]
}`;
}

function normalizeDocument(data: Partial<ProposalDocumentData>, input: ProposalGenerationInput): ProposalDocumentData {
  return {
    solutionName: sanitizeLine(data.solutionName ?? '', 'Inventory Intelligence and Reordering Automation Platform'),
    solutionSubtitle: sanitizeLine(data.solutionSubtitle ?? '', `Prepared for ${input.companyName}`),
    executiveSummary: normalizeParagraphs(data.executiveSummary, 'This proposal outlines a practical inventory intelligence and automation platform tailored to the client workflow described in the request.'),
    challengeIntro: sanitizeLine(data.challengeIntro ?? '', `${input.companyName} is currently relying on spreadsheet-heavy inventory and purchasing processes that slow decision-making and make reordering harder than it needs to be.`),
    challengePoints: normalizeBullets(data.challengePoints, 3),
    solutionOverview: normalizeParagraphs(data.solutionOverview, 'We propose a staged implementation that centralizes inventory visibility, automates replenishment logic, and gives management flexible reporting.'),
    architectureTable: normalizeTable(data.architectureTable as ProposalDocumentData['architectureTable'], ['Layer', 'Components', 'Function']),
    keyCapabilities: normalizeBullets(data.keyCapabilities, 4),
    workflowTransformationTitle: sanitizeLine(data.workflowTransformationTitle ?? '', 'Workflow Transformation'),
    workflowTransformationIntro: sanitizeLine(data.workflowTransformationIntro ?? '', 'The proposed platform replaces manual spreadsheet reconciliation with a repeatable data and planning workflow.'),
    workflowTable: normalizeTable(data.workflowTable as ProposalDocumentData['workflowTable'], ['Current Workflow', 'Automated Future State', 'Business Impact']),
    technicalApproachTitle: sanitizeLine(data.technicalApproachTitle ?? '', 'Integration Architecture'),
    integrationTable: normalizeTable(data.integrationTable as ProposalDocumentData['integrationTable'], ['Workstream', 'Approach', 'Output']),
    implementationSteps: normalizeParagraphs(data.implementationSteps, 'Confirm the implementation workplan and data dependencies during kickoff.'),
    securityControls: normalizeBullets(data.securityControls, 3),
    roadmapIntro: sanitizeLine(data.roadmapIntro ?? '', 'We recommend a phased rollout that delivers visibility first, then automation and forecasting.'),
    roadmapTable: normalizeTable(data.roadmapTable as ProposalDocumentData['roadmapTable'], ['Phase', 'Scope', 'Deliverables', 'Duration']),
    roadmapNote: sanitizeLine(data.roadmapNote ?? '', 'Final timing will be confirmed after discovery and data validation.'),
    investmentIntro: sanitizeLine(data.investmentIntro ?? '', 'The following ranges are indicative and will be refined after discovery.'),
    investmentTable: normalizeTable(data.investmentTable as ProposalDocumentData['investmentTable'], ['Component', 'Estimated Range', 'Billing Model']),
    investmentNote: sanitizeLine(data.investmentNote ?? '', 'Infrastructure, third-party licenses, and any ERP connector costs are excluded unless explicitly stated.'),
    whyUs: normalizeBullets(data.whyUs, 3),
    nextStepsIntro: sanitizeLine(data.nextStepsIntro ?? '', 'We recommend the following immediate actions to move forward:'),
    nextSteps: normalizeParagraphs(data.nextSteps, 'Schedule a working session to confirm scope, data availability, and implementation priorities.'),
  };
}

function extractCompanyWebsite(prompt: string): string | null {
  const match = prompt.match(/https?:\/\/[^\s)]+/i);
  return match ? match[0].replace(/[.,;:!?]+$/, '') : null;
}

function buildRenderPayload(document: ProposalDocumentData, input: ProposalGenerationInput) {
  const currentDate = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return {
    meta: {
      firmName: input.firmProfile.firm_name || 'Bab Al Ilm AI',
      firmTagline: 'Intelligent Solutions for the Modern Enterprise',
      preparedFor: input.companyName,
      preparedBy: input.preparedByName,
      preparedByCompany: input.firmProfile.firm_name || 'Bab Al Ilm AI',
      dateLabel: currentDate,
      classification: 'Confidential',
      contactName: input.preparedByName,
      contactRole: '',
      contactCompany: input.firmProfile.firm_name || 'Bab Al Ilm AI',
      contactEmail: input.preparedByEmail || input.firmProfile.contact_email || '',
      firmWebsite: input.firmProfile.contact_website || '',
      companyWebsite: extractCompanyWebsite(input.originalPrompt) || '',
      accentNavy: '#1F355E',
      accentBlue: '#2E73B8',
      accentGold: '#C88A1A',
      fileTitle: `${slugify(input.companyName || 'proposal')}-proposal-${new Date().toISOString().slice(0, 10)}.pdf`,
    },
    document,
  };
}

async function renderProposalArtifact(payload: Record<string, unknown>, fileStem: string): Promise<{ jsonPath: string; pdfPath: string; pdfBuffer: Buffer }> {
  ensureDirs();

  const jsonPath = path.join(OUTPUT_DIR, `${fileStem}.json`);
  const pdfPath = path.join(OUTPUT_DIR, `${fileStem}.pdf`);
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

  const pythonBin = getPythonBin();
  await execFileAsync(pythonBin, [RENDER_SCRIPT, jsonPath, pdfPath], {
    cwd: process.cwd(),
    maxBuffer: 10 * 1024 * 1024,
  });

  return {
    jsonPath,
    pdfPath,
    pdfBuffer: fs.readFileSync(pdfPath),
  };
}

export function isProposalTask(context: Record<string, unknown>, persona: string, subtask: string): boolean {
  if (persona !== 'BUSINESS_ANALYST') return false;
  if (typeof context.deliverable_type === 'string' && context.deliverable_type.toLowerCase() === 'proposal') return true;
  return /\bproposal\b/i.test(subtask);
}

export async function createProposalPdf(input: ProposalGenerationInput, onProgress?: ProposalProgressReporter): Promise<ProposalRouteResult> {
  ensureDirs();
  await ensureTable();

  await onProgress?.('Building proposal content blueprint');
  const rawDocument = await generateJson<ProposalDocumentData>({
    system: buildProposalJsonSystemPrompt(input),
    messages: [
      {
        role: 'user',
        content: `Original request:\n${input.originalPrompt}\n\nBusiness Analyst draft:\n${input.proposalDraft}`,
      },
    ],
    maxTokens: 7200,
    temperature: 0.1,
    preferredProvider: CLAUDE_PROVIDER,
  });

  const document = normalizeDocument(rawDocument, input);
  const payload = buildRenderPayload(document, input);
  const proposalId = randomUUID();
  const fileStem = `${new Date().toISOString().slice(0, 10)}-${slugify(input.companyName || 'proposal')}-${proposalId.slice(0, 8)}`;
  await onProgress?.('Rendering proposal PDF');
  const rendered = await renderProposalArtifact(payload as Record<string, unknown>, fileStem);

  await db.query(
    `INSERT INTO ${PROPOSAL_TABLE} (id, user_id, title, pdf_path, json_path, pdf_data, json_payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())`,
    [proposalId, input.userId, document.solutionName, rendered.pdfPath, rendered.jsonPath, rendered.pdfBuffer, JSON.stringify(payload)]
  );

  return {
    proposalId,
    title: document.solutionName,
    openUrl: `/api/proposals/${proposalId}`,
  };
}

export async function getStoredProposalForUser(proposalId: string, userId: string): Promise<StoredProposalRecord | null> {
  await ensureTable();
  return db.queryOne<StoredProposalRecord>(
    `SELECT id, user_id, title, pdf_path, json_path, pdf_data, json_payload, created_at
     FROM ${PROPOSAL_TABLE}
     WHERE id = $1 AND user_id = $2`,
    [proposalId, userId]
  );
}

export async function restoreStoredProposalPdf(record: StoredProposalRecord): Promise<Buffer | null> {
  await ensureTable();
  if (!record.json_payload) {
    return null;
  }

  const fileStem = `${new Date().toISOString().slice(0, 10)}-${slugify(record.title || 'proposal')}-${record.id.slice(0, 8)}-restored`;
  const rendered = await renderProposalArtifact(record.json_payload, fileStem);

  await db.query(
    `UPDATE ${PROPOSAL_TABLE}
     SET pdf_path = $3,
         json_path = $4,
         pdf_data = $5,
         json_payload = COALESCE(json_payload, $6::jsonb)
     WHERE id = $1 AND user_id = $2`,
    [record.id, record.user_id, rendered.pdfPath, rendered.jsonPath, rendered.pdfBuffer, JSON.stringify(record.json_payload)]
  );

  return rendered.pdfBuffer;
}
