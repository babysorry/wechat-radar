import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { wxSessions } from '@/lib/wx';
import { todayStr } from '@/lib/range';
import { createNameResolver } from '@/lib/wechat-names';

export const dynamic = 'force-dynamic';

type RawLinkRow = {
  chatroom_id: string;
  local_id: number;
  sender: string;
  sender_username: string;
  time: string;
  url: string;
  canonical_url: string;
  title: string | null;
  domain: string;
  source: string;
  raw_kind: string;
};

export async function GET(req: NextRequest) {
  const date = new URL(req.url).searchParams.get('date') ?? todayStr();
  const names = await groupNames();
  const display = createNameResolver();
  const rows = db()
    .prepare(
      `SELECT ml.chatroom_id, ml.local_id, ml.sender, m.sender_username, ml.time,
              ml.url, ml.canonical_url, ml.title, ml.domain, ml.source, ml.raw_kind
       FROM message_links ml
       LEFT JOIN messages m ON m.chatroom_id = ml.chatroom_id AND m.local_id = ml.local_id
       WHERE ml.date = ?
         AND ml.canonical_url LIKE '%://mp.weixin.qq.com/%'
       ORDER BY ml.timestamp DESC
       LIMIT 200`,
    )
    .all(date) as RawLinkRow[];

  return NextResponse.json({
    ok: true,
    date,
    links: rows.map((row) => ({
      ...row,
      sender: display.sender(row.chatroom_id, row.sender, row.sender_username),
      chat_name: names.get(row.chatroom_id) ?? display.chat(row.chatroom_id),
    })),
  });
}

async function groupNames() {
  const names = new Map<string, string>();
  try {
    const sessions = await wxSessions(500);
    for (const s of sessions) names.set(s.username, s.chat);
  } catch {}
  return names;
}
