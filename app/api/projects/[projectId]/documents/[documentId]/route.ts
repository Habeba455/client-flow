import { NextResponse } from 'next/server';
import { purgeProjectSemanticSource } from '@/lib/assistant/project-semantic-memory';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/current-user';

export async function DELETE(
  _request: Request,
  { params }: { params: { projectId: string; documentId: string } }
) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const deleted = await db.queryOne<{ id: string }>(
    `DELETE FROM project_documents
     WHERE id = $1
       AND project_id = $2
       AND user_id = $3
     RETURNING id`,
    [params.documentId, params.projectId, current.user.id]
  );

  if (!deleted) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 });
  }

  await purgeProjectSemanticSource(params.projectId, 'document', params.documentId);

  return NextResponse.json({ ok: true });
}
