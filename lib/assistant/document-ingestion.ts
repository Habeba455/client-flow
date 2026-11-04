import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { generateText } from '@/lib/ai/provider';
import { getAnthropicSpecModel } from '@/lib/ai/spec-models';
import { db } from '@/lib/db';

export interface ProjectDocumentInsertInput {
  projectId: string;
  userId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  storageProvider: string;
  summary: string;
  fullText?: string | null;
  driveFileId?: string | null;
  driveUrl?: string | null;
  documentType?: string | null;
  tags?: string[];
  sourceEmailThreadId?: string | null;
}

const PROJECT_DOCUMENT_STORAGE_PROVIDERS = new Set(['google_drive', 'onedrive', 'local']);
const execFileAsync = promisify(execFile);

function normalizeExtractedText(value: string): string | null {
  const normalized = value
    .replace(/\r/g, '\n')
    .replace(/\u0000/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!normalized) {
    return null;
  }

  return normalized.slice(0, 40_000);
}

async function withTemporaryPdfFiles<T>(buffer: Buffer, callback: (inputPath: string, workingDir: string) => Promise<T>): Promise<T> {
  const workingDir = await mkdtemp(join(tmpdir(), 'project-doc-'));
  const inputPath = join(workingDir, 'source.pdf');
  await writeFile(inputPath, buffer);

  try {
    return await callback(inputPath, workingDir);
  } finally {
    await rm(workingDir, { recursive: true, force: true });
  }
}

async function extractPdfTextWithPdftotext(inputPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('pdftotext', ['-layout', '-enc', 'UTF-8', inputPath, '-'], {
      maxBuffer: 20 * 1024 * 1024,
    });
    return normalizeExtractedText(stdout || '');
  } catch {
    return null;
  }
}

async function extractPdfTextWithOcr(inputPath: string, workingDir: string): Promise<string | null> {
  try {
    const outputPrefix = join(workingDir, 'page');
    await execFileAsync('pdftoppm', ['-f', '1', '-l', '6', '-png', inputPath, outputPrefix], {
      maxBuffer: 20 * 1024 * 1024,
    });

    const imageFiles = (await readdir(workingDir))
      .filter((name) => /^page-\d+\.png$/i.test(name))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

    if (imageFiles.length === 0) {
      return null;
    }

    const textParts: string[] = [];
    for (const imageFile of imageFiles) {
      const { stdout } = await execFileAsync('tesseract', [join(workingDir, imageFile), 'stdout', '--psm', '6'], {
        maxBuffer: 20 * 1024 * 1024,
      });
      if (stdout?.trim()) {
        textParts.push(stdout);
      }
    }

    return normalizeExtractedText(textParts.join('\n\n'));
  } catch {
    return null;
  }
}

export function normalizeProjectDocumentStorageProvider(value: string | null | undefined): string {
  const normalized = (value || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (PROJECT_DOCUMENT_STORAGE_PROVIDERS.has(normalized)) {
    return normalized;
  }
  return 'local';
}

export function inferDocumentType(fileName: string, mimeType: string): string | null {
  const lower = fileName.toLowerCase();
  if (mimeType.includes('pdf') || lower.endsWith('.pdf')) return 'pdf';
  if (mimeType.includes('word') || lower.endsWith('.docx')) return 'docx';
  if (mimeType.includes('sheet') || lower.endsWith('.xlsx') || lower.endsWith('.csv')) return 'spreadsheet';
  if (mimeType.startsWith('text/') || lower.endsWith('.md') || lower.endsWith('.txt')) return 'text';
  if (mimeType.includes('presentation') || lower.endsWith('.pptx')) return 'presentation';
  if (mimeType.startsWith('image/')) return 'image';
  return null;
}

export async function extractTextFromBuffer(fileName: string, mimeType: string, buffer: Buffer): Promise<string | null> {
  const lower = fileName.toLowerCase();
  if (
    mimeType.startsWith('text/') ||
    mimeType.includes('json') ||
    mimeType.includes('xml') ||
    lower.endsWith('.md') ||
    lower.endsWith('.txt') ||
    lower.endsWith('.csv')
  ) {
    return normalizeExtractedText(buffer.toString('utf8'));
  }

  if (mimeType.includes('pdf') || lower.endsWith('.pdf')) {
    let parserText: string | null = null;
    let parser: { getText: () => Promise<{ text?: string }>; destroy?: () => Promise<void> | void } | null = null;

    try {
      const { PDFParse } = await import('pdf-parse');
      parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      parserText = normalizeExtractedText(result.text || '');
    } catch {
      parserText = null;
    } finally {
      await parser?.destroy?.();
    }

    if (parserText && parserText.length >= 500) {
      return parserText;
    }

    const fallbackText = await withTemporaryPdfFiles(buffer, async (inputPath, workingDir) => {
      const pdftotextText = await extractPdfTextWithPdftotext(inputPath);
      if (pdftotextText && pdftotextText.length >= 500) {
        return pdftotextText;
      }

      const ocrText = await extractPdfTextWithOcr(inputPath, workingDir);
      if (ocrText && (!pdftotextText || ocrText.length >= pdftotextText.length)) {
        return ocrText;
      }

      return pdftotextText;
    });

    if (fallbackText && (!parserText || fallbackText.length >= parserText.length)) {
      return fallbackText;
    }

    return parserText;
  }

  if (mimeType.includes('word') || lower.endsWith('.docx')) {
    try {
      const mammothModule = await import('mammoth');
      const mammoth = mammothModule.default || mammothModule;
      const result = await mammoth.extractRawText({ buffer });
      return normalizeExtractedText(result.value || '');
    } catch {
      return null;
    }
  }

  if (mimeType.includes('sheet') || lower.endsWith('.xlsx')) {
    try {
      const excelModule = await import('exceljs');
      const ExcelJS = excelModule.default || excelModule;
      const workbook = new ExcelJS.Workbook();
      const workbookBuffer = buffer as unknown as Parameters<typeof workbook.xlsx.load>[0];
      await workbook.xlsx.load(workbookBuffer);

      const text = workbook.worksheets
        .map((sheet) => {
          const rows = sheet
            .getSheetValues()
            .slice(1)
            .map((row) => {
              if (!Array.isArray(row)) {
                return '';
              }
              return row
                .slice(1)
                .map((cell) => String(cell ?? '').trim())
                .filter(Boolean)
                .join(' | ');
            })
            .filter(Boolean);

          return [`Sheet: ${sheet.name}`, ...rows].join('\n');
        })
        .filter(Boolean)
        .join('\n\n');

      return normalizeExtractedText(text);
    } catch {
      return null;
    }
  }

  return null;
}

export async function summarizeProjectDocument(params: {
  fileName: string;
  projectName?: string | null;
  projectDescription?: string | null;
  extractedText?: string | null;
  fallbackSummary?: string | null;
}): Promise<string> {
  const extractedText = params.extractedText?.trim() || '';
  if (!extractedText) {
    return (
      params.fallbackSummary?.trim() ||
      (/\.pdf$/i.test(params.fileName)
        ? 'No extractable text was found in this PDF during parsing or OCR, so project Q&A cannot use its contents yet.'
        : 'Document saved to project memory. Text extraction is not available for this file type in the current environment.')
    );
  }

  try {
    return await generateText({
      system:
        'You summarize project documents for a professional-services workspace. Return exactly 2 concise sentences covering purpose, scope, and the most important facts to remember.',
      messages: [
        {
          role: 'user',
          content: [
            `Project: ${params.projectName || 'Unspecified project'}`,
            params.projectDescription ? `Project description: ${params.projectDescription}` : '',
            `Document: ${params.fileName}`,
            '',
            extractedText.slice(0, 8_000),
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
      maxTokens: 180,
      temperature: 0.2,
      preferredProvider: 'anthropic',
      model: getAnthropicSpecModel('sonnet'),
    });
  } catch {
    const compact = extractedText.replace(/\s+/g, ' ').trim();
    return compact.length > 220 ? `${compact.slice(0, 217)}...` : compact;
  }
}

export async function insertProjectDocumentRecord(params: ProjectDocumentInsertInput): Promise<{ id: string } | null> {
  const existing = await db.queryOne<{ id: string }>(
    `SELECT id
     FROM project_documents
     WHERE project_id = $1
       AND user_id = $2
       AND file_name = $3
       AND COALESCE(source_email_thread_id, '') = COALESCE($4, '')
     LIMIT 1`,
    [params.projectId, params.userId, params.fileName, params.sourceEmailThreadId || null]
  );

  if (existing) {
    await db.query(
      `UPDATE project_documents
       SET file_type = $2,
           file_size = $3,
           drive_file_id = $4,
           drive_url = $5,
           storage_provider = $6,
           summary = $7,
           document_type = $8,
           full_text = $9,
           tags = $10::text[],
           source_email_thread_id = $11,
           analyzed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [
        existing.id,
        params.mimeType,
        params.fileSize,
        params.driveFileId || null,
        params.driveUrl || null,
        normalizeProjectDocumentStorageProvider(params.storageProvider),
        params.summary,
        params.documentType || null,
        params.fullText || null,
        params.tags || [],
        params.sourceEmailThreadId || null,
      ]
    );
    return existing;
  }

  const storageProvider = normalizeProjectDocumentStorageProvider(params.storageProvider);

  return db.queryOne<{ id: string }>(
    `INSERT INTO project_documents (
       id, project_id, user_id, file_name, file_type, file_size, drive_file_id, drive_url,
       storage_provider, summary, key_points, extracted_data, document_type, full_text, tags,
       source_email_thread_id, analyzed_at, created_at, updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, '[]'::jsonb, '{}'::jsonb, $11, $12, $13::text[],
       $14, NOW(), NOW(), NOW()
     )
     RETURNING id`,
    [
      randomUUID(),
      params.projectId,
      params.userId,
      params.fileName,
      params.mimeType,
      params.fileSize,
      params.driveFileId || null,
      params.driveUrl || null,
      storageProvider,
      params.summary,
      params.documentType || null,
      params.fullText || null,
      params.tags || [],
      params.sourceEmailThreadId || null,
    ]
  );
}
