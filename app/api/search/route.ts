import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { wxSessions } from '@/lib/wx';
import { createNameResolver } from '@/lib/wechat-names';

export const dynamic = 'force-dynamic';

type SearchResult = {
  id: string;
  type: 'group' | 'topic' | 'person' | 'message' | 'link';
  title: string;
  subtitle: string;
  href: string;
  external?: boolean;
};

type MessageRow = {
  chatroom_id: string;
  sender: string;
  sender_username: string;
  content: string;
  date: string;
  time: string;
};

type TopicRow = {
  id: number;
  date: string;
  title: string;
  summary: string | null;
  message_count: number;
  group_count: number;
};

type LinkRow = {
  canonical_url: string;
  title: string | null;
  domain: string;
  date: string;
};

type PersonRow = {
  sender: string;
  chatroom_id: string;
  hits: number;
  groups: number;
  latest: string;
};

export async function GET(req: NextRequest) {
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim();
  if (q.length < 2) return NextResponse.json({ ok: true, results: [] });

  const like = `%${q}%`;
  const nameMap = await loadGroupNames();
  const names = createNameResolver();
  const results: SearchResult[] = [];

  for (const [chatroomId, name] of nameMap) {
    if (!name.toLowerCase().includes(q.toLowerCase())) continue;
    results.push({
      id: `group:${chatroomId}`,
      type: 'group',
      title: name,
      subtitle: chatroomId,
      href: `/groups/${encodeURIComponent(chatroomId)}`,
    });
    if (results.length >= 8) break;
  }

  const topics = db()
    .prepare(
      `SELECT id, date, title, summary, message_count, group_count
       FROM topics
       WHERE title LIKE ? OR COALESCE(summary, '') LIKE ?
       ORDER BY date DESC, message_count DESC
       LIMIT 8`,
    )
    .all(like, like) as TopicRow[];
  for (const t of topics) {
    results.push({
      id: `topic:${t.id}`,
      type: 'topic',
      title: t.title,
      subtitle: `${t.date} · ${t.message_count} 条 · ${t.group_count} 群${t.summary ? ` · ${t.summary}` : ''}`,
      href: `/topics?date=${t.date}`,
    });
  }

  const people = db()
    .prepare(
      `SELECT COALESCE(NULLIF(m.sender_username, ''), m.sender) AS sender,
              m.chatroom_id, COUNT(*) AS hits, COUNT(DISTINCT m.chatroom_id) AS groups, MAX(m.date) AS latest
       FROM messages m
       LEFT JOIN wechat_names member ON member.scope = m.chatroom_id
         AND member.username = COALESCE(NULLIF(m.sender_username, ''), m.sender)
       LEFT JOIN wechat_names contact ON contact.scope = ''
         AND contact.username = COALESCE(NULLIF(m.sender_username, ''), m.sender)
       WHERE m.sender LIKE ? OR m.sender_username LIKE ? OR member.display_name LIKE ? OR contact.display_name LIKE ?
       GROUP BY COALESCE(NULLIF(m.sender_username, ''), m.sender)
       ORDER BY hits DESC
       LIMIT 8`,
    )
    .all(like, like, like, like) as PersonRow[];
  for (const p of people) {
    results.push({
      id: `person:${p.sender}`,
      type: 'person',
      title: names.sender(p.chatroom_id, p.sender),
      subtitle: `${p.hits} 条消息 · ${p.groups} 个群 · 最近 ${p.latest}`,
      href: `/signals?q=${encodeURIComponent(names.sender(p.chatroom_id, p.sender))}`,
    });
  }

  const messages = db()
    .prepare(
      `SELECT m.chatroom_id, m.sender, m.sender_username, m.content, m.date, m.time
       FROM messages m
       LEFT JOIN wechat_names member ON member.scope = m.chatroom_id
         AND member.username = COALESCE(NULLIF(m.sender_username, ''), m.sender)
       LEFT JOIN wechat_names contact ON contact.scope = ''
         AND contact.username = COALESCE(NULLIF(m.sender_username, ''), m.sender)
       WHERE m.content LIKE ? OR m.sender LIKE ? OR m.sender_username LIKE ?
         OR member.display_name LIKE ? OR contact.display_name LIKE ?
       ORDER BY m.timestamp DESC
       LIMIT 10`,
    )
    .all(like, like, like, like, like) as MessageRow[];
  for (const m of messages) {
    results.push({
      id: `message:${m.chatroom_id}:${m.time}:${m.sender}`,
      type: 'message',
      title: compact(m.content || m.sender, 80),
      subtitle: `${nameMap.get(m.chatroom_id) ?? names.chat(m.chatroom_id)} · ${names.sender(m.chatroom_id, m.sender, m.sender_username)} · ${m.time}`,
      href: `/groups/${encodeURIComponent(m.chatroom_id)}?date=${m.date}`,
    });
  }

  const links = db()
    .prepare(
      `SELECT canonical_url, title, domain, MAX(date) AS date
       FROM message_links
       WHERE canonical_url LIKE ? OR COALESCE(title, '') LIKE ? OR domain LIKE ?
       GROUP BY canonical_url
       ORDER BY MAX(timestamp) DESC
       LIMIT 8`,
    )
    .all(like, like, like) as LinkRow[];
  for (const l of links) {
    results.push({
      id: `link:${l.canonical_url}`,
      type: 'link',
      title: l.title || l.canonical_url,
      subtitle: `${l.domain} · ${l.date}`,
      href: l.canonical_url,
      external: true,
    });
  }

  return NextResponse.json({ ok: true, results: results.slice(0, 32) });
}

async function loadGroupNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const sessions = await wxSessions(500);
    for (const s of sessions) {
      if (s.is_group) names.set(s.username, s.chat);
    }
  } catch {}

  const local = db()
    .prepare(
      `SELECT chatroom_id, COUNT(*) AS n
       FROM messages
       GROUP BY chatroom_id
       ORDER BY n DESC
       LIMIT 500`,
    )
    .all() as Array<{ chatroom_id: string }>;
  const display = createNameResolver();
  for (const row of local) {
    if (!names.has(row.chatroom_id)) names.set(row.chatroom_id, display.chat(row.chatroom_id));
  }
  return names;
}

function compact(s: string, max: number): string {
  const text = s.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
