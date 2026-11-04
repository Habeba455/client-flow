import { NextRequest, NextResponse } from 'next/server';
import { sanitizeProviderError } from '@/lib/ai/provider';
import { getCurrentUser } from '@/lib/current-user';
import { processAssistantRequest } from '@/lib/assistant/request-handler';
import type { AssistantRequest, AssistantResponse } from '@/lib/ai/types';

type AssistantStreamEvent =
  | { type: 'result'; data: AssistantResponse }
  | { type: 'error'; error: string };

function encodeEvent(encoder: TextEncoder, event: AssistantStreamEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`);
}

export async function POST(request: NextRequest) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json()) as AssistantRequest;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = async (event: AssistantStreamEvent) => {
        controller.enqueue(encodeEvent(encoder, event));
      };

      try {
        const response = await processAssistantRequest(
          {
            id: current.user.id,
            name: current.user.name || null,
            email: current.user.email,
          },
          body
        );

        await send({ type: 'result', data: response });
      } catch (error) {
        const message = sanitizeProviderError(error);
        console.error('[api/assistant/stream]', error);
        await send({ type: 'error', error: message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}