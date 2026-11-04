import { getGoogleAccessToken } from '@/lib/google/client';

export async function uploadGoogleDriveFile(params: {
  userId: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  folderId?: string | null;
}): Promise<{ id: string; webViewLink: string } | null> {
  const accessToken = await getGoogleAccessToken(params.userId);
  if (!accessToken) {
    return null;
  }

  const metadata = {
    name: params.fileName,
    mimeType: params.mimeType,
    parents: params.folderId ? [params.folderId] : undefined,
  };

  const boundary = `batch_${Date.now()}`;
  const metadataPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`;
  const fileHeader = `--${boundary}\r\nContent-Type: ${params.mimeType}\r\n\r\n`;
  const footer = `\r\n--${boundary}--`;
  const body = Buffer.concat([
    Buffer.from(metadataPart, 'utf8'),
    Buffer.from(fileHeader, 'utf8'),
    params.buffer,
    Buffer.from(footer, 'utf8'),
  ]);

  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as { id: string; webViewLink: string };
}
