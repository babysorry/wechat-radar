import { db } from './db';
import type { WxMember, WxMessage, WxSession } from './wx-types';

// An empty scope stores contact/group names; a room scope stores its member cards.
interface NameEntry {
  scope: string;
  username: string;
  display_name: string;
}

function usableName(name: string | undefined, username: string): string | undefined {
  return name?.trim() && name !== username ? name : undefined;
}

function saveNames(entries: NameEntry[]) {
  if (!entries.length) return;
  const connection = db();
  const upsert = connection.prepare(`
    INSERT INTO wechat_names (scope, username, display_name, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(scope, username) DO UPDATE SET
      display_name = excluded.display_name, updated_at = excluded.updated_at
    WHERE wechat_names.display_name <> excluded.display_name
  `);
  connection.transaction(() => {
    for (const entry of entries) {
      if (entry.username && usableName(entry.display_name, entry.username)) {
        upsert.run(entry.scope, entry.username, entry.display_name, Date.now());
      }
    }
  })();
}

export function rememberSessionNames(sessions: WxSession[]) {
  saveNames(sessions.map((s) => ({ scope: '', username: s.username, display_name: s.chat })));
}

export function rememberContactNames(contacts: WxMember[]) {
  saveNames(contacts.map((c) => ({
    scope: '', username: c.username,
    display_name: c.contact_display || c.display || c.display_name || c.nickname || '',
  })));
}

export function rememberMemberNames(chatroomId: string, members: WxMember[]) {
  const entries: NameEntry[] = [];
  for (const m of members) {
    const contact = usableName(m.contact_display, m.username);
    const display = [m.group_nickname, m.display, m.display_name, m.nickname, contact]
      .map((name) => usableName(name, m.username)).find(Boolean);
    if (contact) entries.push({ scope: '', username: m.username, display_name: contact });
    if (display) entries.push({ scope: chatroomId, username: m.username, display_name: display });
  }
  saveNames(entries);
}

export function rememberMessageNames(chatroomId: string, messages: WxMessage[]) {
  const entries: NameEntry[] = [];
  for (const m of messages) {
    if (!m.sender_username) continue;
    const username = m.sender_username;
    const contact = usableName(m.sender_contact_display, username);
    const display = usableName(m.sender_group_nickname, username) || usableName(m.sender, username);
    if (contact) entries.push({ scope: '', username, display_name: contact });
    if (display) entries.push({ scope: chatroomId, username, display_name: display });
  }
  saveNames(entries);
}

export function createNameResolver() {
  const rows = db().prepare('SELECT scope, username, display_name FROM wechat_names').all() as NameEntry[];
  const contacts = new Map<string, string>();
  const members = new Map<string, Map<string, string>>();
  for (const row of rows) {
    if (!row.scope) contacts.set(row.username, row.display_name);
    else {
      const room = members.get(row.scope) ?? new Map<string, string>();
      room.set(row.username, row.display_name);
      members.set(row.scope, room);
    }
  }
  return {
    chat: (username: string) => contacts.get(username) ?? username,
    sender: (chatroomId: string, sender: string, username?: string | null) => {
      const identity = username || sender;
      return members.get(chatroomId)?.get(identity) ?? contacts.get(identity) ?? sender ?? identity;
    },
  };
}
