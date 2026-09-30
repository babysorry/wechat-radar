import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { buildTopicsForDate, topicBuildStatus } from '@/lib/topics';

export const dynamic = 'force-dynamic';
export const maxDuration = 3600;

const BuildSchema = z.object({ date: z.iso.date() });
const activeDates = new Set<string>();

export async function POST(req: NextRequest) {
  const parsed = BuildSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: '请选择有效的日期' }, { status: 400 });
  }
  const status = topicBuildStatus();
  if (!status.enabled) {
    return NextResponse.json({ ok: false, code: 'AI_ANALYSIS_DISABLED', error: status.disabledReason }, { status: 409 });
  }
  const { date } = parsed.data;
  if (activeDates.has(date)) {
    return NextResponse.json({ ok: false, error: '该日期的话题正在构建，请稍后刷新查看' }, { status: 409 });
  }
  activeDates.add(date);
  let cancelled = false;
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: unknown) => {
        if (!cancelled) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        send({ type: 'start', date });
        const result = await buildTopicsForDate(date, send);
        send({ type: 'finished', date, ...result });
      } catch (error) {
        send({ type: 'error', error: error instanceof Error ? error.message : '话题构建失败，请稍后重试' });
      } finally {
        activeDates.delete(date);
        if (!cancelled) controller.close();
      }
    },
    cancel() { cancelled = true; },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
