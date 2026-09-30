import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

export async function wxSessions(limit = 500): Promise<WxSession[]> {
  return wxJson<WxSession[]>(['sessions', '-n', String(limit)]);
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
  return wxJson<WxMember[]>(['members', chat]);
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
