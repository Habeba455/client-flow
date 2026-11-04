import { NextRequest, NextResponse } from 'next/server';
import type { ChatMessage } from '@/lib/ai/types';
import { executeApprovalAction } from '@/lib/assistant/action-executor';
import { getApprovalAction, listPendingApprovalActions, updateApprovalAction } from '@/lib/assistant/approvals';
import { getConversation, saveConversation } from '@/lib/assistant/conversations';
import { parseResearchPlanText } from '@/lib/assistant/research-flow';
import { getCurrentUser } from '@/lib/current-user';

export async function POST(request: NextRequest, { params }: { params: { actionId: string } }) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    decision?: 'approve' | 'reject';
    status?: 'EDITING' | 'REJECTED';
    payloadPatch?: Record<string, unknown>;
    researchPlanText?: string;
  };

  const approval = await getApprovalAction(current.user.id, params.actionId);
  if (!approval) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (body.decision === 'reject' || body.status === 'REJECTED') {
    const updated = await updateApprovalAction({
      approvalId: params.actionId,
      userId: current.user.id,
      status: 'REJECTED',
      payloadPatch: { rejected_at: new Date().toISOString() },
    });

    return NextResponse.json({
      approval: updated,
      pendingApprovals: await listPendingApprovalActions(current.user.id, approval.projectId),
      result: { message: 'Approval rejected.' },
    });
  }

  if (body.status === 'EDITING') {
    let payloadPatch = body.payloadPatch;
    if (typeof body.researchPlanText === 'string' && body.researchPlanText.trim()) {
      try {
        const nextPlan = parseResearchPlanText(body.researchPlanText);
        payloadPatch = {
          ...(payloadPatch || {}),
          workflow: 'research_fetch',
          research_plan: nextPlan,
          edited_at: new Date().toISOString(),
        };
      } catch {
        return NextResponse.json({ error: 'Research plan must be valid JSON before saving.' }, { status: 400 });
      }
    }

    const updated = await updateApprovalAction({
      approvalId: params.actionId,
      userId: current.user.id,
      status: 'AWAITING_APPROVAL',
      payloadPatch,
    });

    return NextResponse.json({
      approval: updated,
      pendingApprovals: await listPendingApprovalActions(current.user.id, approval.projectId),
      result: { message: 'Research plan updated. Review it and confirm when ready.' },
    });
  }

  try {
    await updateApprovalAction({
      approvalId: params.actionId,
      userId: current.user.id,
      status: 'APPROVED',
      payloadPatch: { approved_at: new Date().toISOString() },
    });

    await updateApprovalAction({
      approvalId: params.actionId,
      userId: current.user.id,
      status: 'ACTION_IN_PROGRESS',
    });

    const result = await executeApprovalAction(approval);
    const updated = await updateApprovalAction({
      approvalId: params.actionId,
      userId: current.user.id,
      status: 'COMPLETED',
      payloadPatch: {
        ...(result.payloadPatch || {}),
        completed_at: new Date().toISOString(),
      },
    });

    let conversation = null;
    const isResearchComplete =
      result?.payloadPatch && typeof result.payloadPatch === 'object' && (result.payloadPatch as Record<string, unknown>).workflow === 'research_fetch';
    if (isResearchComplete && result?.message && approval.conversationId) {
      const existing = await getConversation(current.user.id, approval.conversationId);
      if (existing) {
        const newMessage: ChatMessage = {
          id: `research_${Date.now()}`,
          role: 'assistant',
          content: result.message,
          createdAt: new Date().toISOString(),
          metadata: { surface: 'assistant', projectId: approval.projectId ?? null },
        };
        conversation = await saveConversation({
          userId: current.user.id,
          conversationId: existing.id,
          projectId: existing.projectId ?? null,
          messages: [...existing.messages, newMessage],
        });
      }
    }

    return NextResponse.json({
      approval: updated,
      pendingApprovals: await listPendingApprovalActions(current.user.id, approval.projectId),
      result,
      conversation: conversation ?? undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Approval execution failed';
    const updated = await updateApprovalAction({
      approvalId: params.actionId,
      userId: current.user.id,
      status: 'AWAITING_APPROVAL',
      payloadPatch: { last_error: message },
    });

    return NextResponse.json(
      {
        error: message,
        approval: updated,
        pendingApprovals: await listPendingApprovalActions(current.user.id, approval.projectId),
      },
      { status: 400 }
    );
  }
}
