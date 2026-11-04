import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { deleteConversation } from '@/lib/assistant/conversations';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { conversationId: string } }
) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const deleted = await deleteConversation(current.user.id, params.conversationId);
  if (!deleted) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
  });
}
