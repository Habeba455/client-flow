import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';

const OUTPUT_DIR = path.join(process.cwd(), 'output', 'generated-files');
const GENERATED_FILES_TABLE = 'assistant_generated_files';

export interface GeneratedFileRouteResult {
  fileId: string;
  title: string;
  fileName: string;
  mimeType: string;
  openUrl: string;
}

export interface StoredGeneratedFileRecord {
  id: string;
  user_id: string;
  project_id: string | null;
  title: string;
  file_name: string;
  mime_type: string;
  file_path: string;
  created_at: string;
}

function ensureDirs() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function ensureTable() {
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${GENERATED_FILES_TABLE} (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  );
  await db.query(`CREATE INDEX IF NOT EXISTS idx_${GENERATED_FILES_TABLE}_user_created ON ${GENERATED_FILES_TABLE} (user_id, created_at DESC)`);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'generated-file';
}

function sanitizeFileName(fileName: string): string {
  const trimmed = fileName.trim().replace(/[/\\?%*:|"<>]/g, '-');
  return trimmed || 'generated-file';
}

export async function createGeneratedFileFromBuffer(params: {
  userId: string;
  projectId?: string | null;
  title: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<GeneratedFileRouteResult> {
  ensureDirs();
  await ensureTable();

  const fileId = randomUUID();
  const safeFileName = sanitizeFileName(params.fileName);
  const storedPath = path.join(OUTPUT_DIR, `${new Date().toISOString().slice(0, 10)}-${slugify(params.title)}-${fileId.slice(0, 8)}-${safeFileName}`);

  fs.writeFileSync(storedPath, params.buffer);

  await db.query(
    `INSERT INTO ${GENERATED_FILES_TABLE} (id, user_id, project_id, title, file_name, mime_type, file_path, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [fileId, params.userId, params.projectId || null, params.title, safeFileName, params.mimeType, storedPath]
  );

  return {
    fileId,
    title: params.title,
    fileName: safeFileName,
    mimeType: params.mimeType,
    openUrl: `/api/generated-files/${fileId}`,
  };
}

export async function createGeneratedFileFromExistingPath(params: {
  userId: string;
  projectId?: string | null;
  title: string;
  fileName: string;
  mimeType: string;
  sourcePath: string;
}): Promise<GeneratedFileRouteResult> {
  const buffer = fs.readFileSync(params.sourcePath);
  return createGeneratedFileFromBuffer({
    userId: params.userId,
    projectId: params.projectId || null,
    title: params.title,
    fileName: params.fileName,
    mimeType: params.mimeType,
    buffer,
  });
}

export async function getStoredGeneratedFileForUser(fileId: string, userId: string): Promise<StoredGeneratedFileRecord | null> {
  await ensureTable();
  return db.queryOne<StoredGeneratedFileRecord>(
    `SELECT id, user_id, project_id, title, file_name, mime_type, file_path, created_at
     FROM ${GENERATED_FILES_TABLE}
     WHERE id = $1 AND user_id = $2`,
    [fileId, userId]
  );
}
