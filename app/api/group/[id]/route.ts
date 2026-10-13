import { NextRequest, NextResponse } from 'next/server';
import { todayStr } from '@/lib/range';
import { db } from '@/lib/db';
import { listMessagesForDate, getSyncState, listAllSyncedDates, backfillMessageIdentities, aggregateDailyStats } from '@/lib/messages-store';
import { wxHistory, wxMembers, wxSessions } from '@/lib/wx';
import { readConfig } from '@/lib/config';
import { createNameResolver } from '@/lib/wechat-names';
import { cache } from '@/lib/cache';
import { getCachedStats, saveStats } from '@/lib/stats-aggregator';

export const dynamic = 'force-dynamic';

interface DailyHistoryRow {
  date: string;
  total: number;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const chatroomId = decodeURIComponent(id);
  const url = new URL(req.url);
  const date = url.searchParams.get('date') ?? todayStr();
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 1000), 5000);

  const demoMode = readConfig().demoMode;
  if (!demoMode) {
    await Promise.allSettled([wxSessions(500), wxMembers(chatroomId)]);
  }

  // 当日消息
  let messages = listMessagesForDate(chatroomId, date, limit);
  const identityKey = `wx:identities:${chatroomId}:${date}`;
  if (!demoMode && messages.some((m) => !m.sender_username) && !cache.get(identityKey)) {
    cache.set(identityKey, true, 300);
    try {
      const source = await wxHistory(chatroomId, date, date, 5000);
      if (backfillMessageIdentities(chatroomId, source)) {
        cache.del(`dashboard-intelligence:${date}:v15`);
        const aggregate = aggregateDailyStats(chatroomId, [date])[0];
        const cached = getCachedStats(chatroomId, date);
        if (!cached || cached.total === aggregate.total) {
          saveStats({ chatroom_id: chatroomId, ...aggregate });
        }
        messages = listMessagesForDate(chatroomId, date, limit);
      }
    } catch (error) {
      cache.set(identityKey, true, 30);
      console.warn('wx sender identity refresh failed; retaining local messages', error);
    }
  }
  const names = createNameResolver();
  const chatName = names.chat(chatroomId);

  // 当日聚合统计
  const total = messages.length;
  const senderMap = new Map<string, number>();
  const senderLabels = new Map<string, string>();
  const typeMap = new Map<string, number>();
  const hours = new Array(24).fill(0) as number[];
  for (const m of messages) {
    const identity = m.sender_username || m.sender;
    senderMap.set(identity, (senderMap.get(identity) ?? 0) + 1);
    senderLabels.set(identity, names.sender(chatroomId, m.sender, m.sender_username));
    typeMap.set(m.type, (typeMap.get(m.type) ?? 0) + 1);
    if (m.timestamp) {
      const h = new Date(m.timestamp * 1000).getHours();
      if (h >= 0 && h < 24) hours[h]++;
    }
  }
  const stats = {
    chat: chatName,
    total,
    by_hour: hours.map((count, hour) => ({ hour, count })),
    by_type: Array.from(typeMap.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    top_senders: Array.from(senderMap.entries())
      .map(([identity, count]) => ({ sender: senderLabels.get(identity) ?? identity, sender_username: identity, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
  };

  // 历史日柱图
  const dailyHistory = db()
    .prepare(
      'SELECT date, total FROM daily_stats WHERE chatroom_id = ? ORDER BY date ASC',
    )
    .all(chatroomId) as DailyHistoryRow[];

  // 同步状态
  const syncState = getSyncState(chatroomId);
  const syncedDates = listAllSyncedDates(chatroomId);

  return NextResponse.json({
    ok: true,
    chatroom_id: chatroomId,
    date,
    stats,
    recent: messages.map((m) => ({ ...m, sender: names.sender(chatroomId, m.sender, m.sender_username) })),
    daily_history: dailyHistory,
    sync_state: syncState ?? null,
    synced_dates: syncedDates,
  });
}
