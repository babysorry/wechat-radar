import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cache } from './cache';
import { createNameResolver, rememberContactNames, rememberMemberNames, rememberSessionNames } from './wechat-names';
import type {
  WxDaemonStatus,
  WxMember,
  WxMessage,
  WxNewMessage,
  WxSession,
  WxStats,
} from './wx-types';

const run = promisify(execFile);

const DEFAULT_OPTS = {
  maxBuffer: 64 * 1024 * 1024,
  timeout: 60_000,
} as const;

async function wxRaw(args: string[], opts = DEFAULT_OPTS): Promise<string> {
  const { stdout } = await run('wx', args, opts);
  return stdout;
}

function isNoRecordsError(error: unknown): boolean {
  const stderr = (error as { stderr?: string } | null)?.stderr ?? '';
  return /找不到 .+ 的消息记录/.test(stderr);
}

async function wxJson<T>(args: string[], opts = DEFAULT_OPTS): Promise<T> {
  const stdout = await wxRaw([...args, '--json'], opts);
  const parsed = JSON.parse(stdout);
  if (parsed?.meta?.unknown_shards?.length || parsed?.meta?.status === 'possibly_stale_unknown_shards') {
    throw new Error('普通聊天消息分片缺少密钥，请重新运行微信初始化脚本');
  }
  // Newer wx-cli versions return arrays inside a metadata wrapper.
  const arrayKeys: Record<string, string[]> = {
    sessions: ['sessions'],
    history: ['messages'],
    'new-messages': ['messages'],
    members: ['members'],
    contacts: ['contacts'],
  };
  const keys = arrayKeys[args[0]];
  if (keys) {
    if (Array.isArray(parsed)) return parsed as T;
    for (const key of keys) {
      if (Array.isArray(parsed?.[key])) return parsed[key] as T;
    }
    throw new Error(`wx ${args[0]} returned an unexpected response format`);
  }
  return (parsed?.stats ?? parsed) as T;
}

const sessionLoads = new Map<number, Promise<WxSession[]>>();
export async function wxSessions(limit = 500): Promise<WxSession[]> {
  const key = `wx:sessions:${limit}`;
  const cached = cache.get<WxSession[]>(key);
  if (cached) return cached;
  const pending = sessionLoads.get(limit);
  if (pending) return pending;
  const load = loadSessions(limit).then((sessions) => {
    cache.set(key, sessions, 30);
    return sessions;
  }).finally(() => { sessionLoads.delete(limit); });
  sessionLoads.set(limit, load);
  return load;
}

async function loadSessions(limit: number): Promise<WxSession[]> {
  let sessions = await wxJson<WxSession[]>(['sessions', '-n', String(limit)]);
  const groups = sessions.filter((s) => s.is_group);
  // wx-cli can start before contact.db is ready and retain an empty Names map.
  if (groups.length && groups.every((s) => !s.chat?.trim() || s.chat === s.username)) {
    try {
      await refreshDaemonNames();
      sessions = await wxJson<WxSession[]>(['sessions', '-n', String(limit)]);
    } catch (error) {
      console.warn('wx contact refresh failed; retaining saved names', error);
    }
  }
  rememberSessionNames(sessions);
  await loadContactNames();
  const names = createNameResolver();
  return sessions.map((s) => ({
    ...s,
    chat: names.chat(s.username),
    last_sender: names.sender(s.username, s.last_sender),
  }));
}

let contactLoad: Promise<void> | undefined;
async function loadContactNames() {
  if (cache.get('wx:contacts:loaded')) return;
  if (!contactLoad) {
    contactLoad = wxJson<WxMember[]>(['contacts', '-n', '100000'])
      .then((contacts) => {
        rememberContactNames(contacts);
        cache.set('wx:contacts:loaded', true, contacts.length ? 300 : 30);
      })
      .catch((error) => {
        cache.set('wx:contacts:loaded', true, 30);
        console.warn('wx contacts failed; retaining saved names', error);
      })
      .finally(() => { contactLoad = undefined; });
  }
  await contactLoad;
}

let daemonRefresh: Promise<void> | undefined;
function refreshDaemonNames(): Promise<void> {
  if (daemonRefresh) return daemonRefresh;
  if (process.platform === 'win32' || cache.get('wx:names:refresh-attempt')) return Promise.resolve();
  cache.set('wx:names:refresh-attempt', true, 60);
  daemonRefresh = new Promise<void>((resolve, reject) => {
    const socket = createConnection(join(homedir(), '.wx-cli', 'daemon.sock'));
    let output = '';
    socket.setTimeout(10_000, () => socket.destroy(new Error('wx contact refresh timed out')));
    socket.on('connect', () => socket.write(`${JSON.stringify({ cmd: 'reload_config' })}\n`));
    socket.on('error', reject);
    socket.on('end', () => reject(new Error('wx contact refresh returned no response')));
    socket.on('data', (data) => {
      output += data.toString();
      if (!output.includes('\n')) return;
      try {
        const response = JSON.parse(output.split('\n')[0]);
        if (!response.ok) throw new Error(response.error || 'wx contact refresh failed');
        cache.del('wx:contacts:loaded');
        resolve();
      } catch (error) { reject(error); }
      finally { socket.destroy(); }
    });
  }).finally(() => { daemonRefresh = undefined; });
  return daemonRefresh;
}

export async function wxStats(
  chat: string,
  since: string,
  until: string,
): Promise<WxStats> {
  return wxJson<WxStats>(['stats', chat, '--since', since, '--until', until]);
}

export async function wxHistory(
  chat: string,
  since: string,
  until: string,
  limit = 1000,
): Promise<WxMessage[]> {
  try {
    return await wxJson<WxMessage[]>([
      'history',
      chat,
      '--since',
      since,
      '--until',
      until,
      '-n',
      String(limit),
    ]);
  } catch (error) {
    // wx-cli 0.6.3 reports an error when the requested date window has no
    // matching shard. Confirm an empty window with stats before accepting it.
    if (isNoRecordsError(error)) {
      try {
        const stats = await wxStats(chat, since, until);
        if (stats.total === 0) return [];
      } catch (statsError) {
        // A purged local history can also have no stats table. Accept an empty
        // window only when the session confirms its last activity predates it.
        if (isNoRecordsError(statsError)) {
          const start = Date.parse(since.length === 10 ? `${since}T00:00:00` : since.replace(' ', 'T')) / 1000;
          if (Number.isFinite(start)) {
            const sessions = await wxSessions(500);
            const session = sessions.find((item) => item.username === chat || item.chat === chat);
            if (session && session.timestamp > 0 && session.timestamp < start) return [];
          }
        }
        throw statsError;
      }
    }
    throw error;
  }
}

export async function wxNewMessages(limit = 50): Promise<WxNewMessage[]> {
  return wxJson<WxNewMessage[]>(['new-messages', '-n', String(limit)]);
}

export async function wxMembers(chat: string): Promise<WxMember[]> {
  const key = `wx:members:${chat}`;
  const cached = cache.get<WxMember[]>(key);
  if (cached) return cached;
  const members = await wxJson<WxMember[]>(['members', chat]);
  rememberMemberNames(chat, members);
  cache.set(key, members, 300);
  return members;
}

export async function wxDaemonStatus(): Promise<WxDaemonStatus> {
  try {
    const out = await wxRaw(['daemon', 'status']);
    const lower = out.toLowerCase();
    const stopped = /\bnot\s+running\b|\bstopped\b|未运行|未启动|没有运行/.test(lower);
    const running = !stopped && (/\brunning\b/.test(lower) || lower.includes('运行中'));
    const pidMatch = out.match(/pid[^\d]*(\d+)/i);
    return {
      running,
      pid: pidMatch ? Number(pidMatch[1]) : undefined,
    };
  } catch {
    return { running: false };
  }
}

export async function wxAvailable(): Promise<boolean> {
  try {
    await run('wx', ['--version'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
