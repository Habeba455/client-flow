import fs from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { getStoredProposalForUser, restoreStoredProposalPdf } from '@/lib/proposals/service';

export async function GET(_request: NextRequest, { params }: { params: { proposalId: string } }) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const proposal = await getStoredProposalForUser(params.proposalId, current.user.id);
  if (!proposal) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let fileBuffer = proposal.pdf_data;
  if (!fileBuffer && fs.existsSync(proposal.pdf_path)) {
    fileBuffer = fs.readFileSync(proposal.pdf_path);
  }

  if (!fileBuffer) {
    fileBuffer = await restoreStoredProposalPdf(proposal);
  }

  if (!fileBuffer) {
    return NextResponse.json({ error: 'PDF file is missing' }, { status: 404 });
  }

  const filename = `${proposal.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'proposal'}.pdf`;

  return new NextResponse(new Uint8Array(fileBuffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
