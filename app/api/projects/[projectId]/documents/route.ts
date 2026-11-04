import { NextRequest, NextResponse } from 'next/server';
import { extractTextFromBuffer, inferDocumentType, insertProjectDocumentRecord, summarizeProjectDocument } from '@/lib/assistant/document-ingestion';
import { refreshProjectSemanticMemory } from '@/lib/assistant/project-semantic-memory';
import { ensureAssistantRuntimeTables } from '@/lib/assistant/schema';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/current-user';

export async function POST(request: NextRequest, { params }: { params: { projectId: string } }) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await ensureAssistantRuntimeTables();

  const project = await db.queryOne<{ id: string; name: string | null; title: string | null; description: string | null }>(
    `SELECT id, name, title, description
     FROM projects
     WHERE id = $1 AND user_id = $2`,
    [params.projectId, current.user.id]
  );
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const formData = await request.formData();
  const files = formData
    .getAll('files')
    .filter((entry): entry is File => typeof File !== 'undefined' && entry instanceof File);

  if (files.length === 0) {
    return NextResponse.json({ error: 'No files uploaded' }, { status: 400 });
  }

  const documents = [];
  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || 'application/octet-stream';
    const extractedText = await extractTextFromBuffer(file.name, mimeType, buffer);
    const summary = await summarizeProjectDocument({
      fileName: file.name,
      projectName: project.title || project.name,
      projectDescription: project.description,
      extractedText,
    });

    const inserted = await insertProjectDocumentRecord({
      projectId: params.projectId,
      userId: current.user.id,
      fileName: file.name,
      mimeType,
      fileSize: file.size,
      driveFileId: null,
      driveUrl: null,
      storageProvider: 'local',
      summary,
      fullText: extractedText,
      documentType: inferDocumentType(file.name, mimeType),
      tags: ['upload'],
    });

    if (!inserted) {
      continue;
    }

    const row = await db.queryOne<{
      id: string;
      file_name: string;
      summary: string | null;
      storage_provider: string | null;
      created_at: string;
    }>(
      `SELECT id, file_name, summary, storage_provider, created_at
       FROM project_documents
       WHERE id = $1`,
      [inserted.id]
    );

    if (row) {
      documents.push(row);
    }
  }

  await refreshProjectSemanticMemory(params.projectId, true);

  return NextResponse.json({ documents });
}
