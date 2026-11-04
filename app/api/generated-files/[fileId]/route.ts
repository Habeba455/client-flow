import fs from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { getStoredGeneratedFileForUser } from '@/lib/generated-files/service';

function shouldDownload(mimeType: string): boolean {
  return (
    mimeType.includes('spreadsheet') ||
    mimeType.includes('sheet') ||
    mimeType.includes('excel') ||
    mimeType === 'application/zip'
  );
}

export async function GET(_request: NextRequest, { params }: { params: { fileId: string } }) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const file = await getStoredGeneratedFileForUser(params.fileId, current.user.id);
  if (!file) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (!fs.existsSync(file.file_path)) {
    return NextResponse.json({ error: 'Generated file is missing' }, { status: 404 });
  }

  const buffer = fs.readFileSync(file.file_path);
  const disposition = shouldDownload(file.mime_type) ? 'attachment' : 'inline';

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': file.mime_type,
      'Content-Disposition': `${disposition}; filename="${file.file_name}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
