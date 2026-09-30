'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Sidebar from '@/components/Sidebar';
import MessageContent from '@/components/MessageContent';
import { Sparkles, RefreshCw, Calendar } from 'lucide-react';

type Topic = {
  id: number;
  date: string;
  title: string;
  summary: string;
  message_count: number;
  group_count: number;
};

type TopicMessage = {
  chatroom_id: string;
  chat_name: string;
  local_id: number;
  sender: string;
  content: string;
  time: string;
  timestamp: number;
  type: string;
  score: number;
};

function localToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function TopicsPage() {
  const [date, setDate] = useState(() => localToday());
  const [topics, setTopics] = useState<Topic[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<{ topic: Topic; messages: TopicMessage[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [buildStatus, setBuildStatus] = useState<{ enabled: boolean; disabledReason: string | null } | null>(null);
  const [info, setInfo] = useState<string | undefined>(undefined);

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const r = await fetch(`/api/topics?date=${date}`, { signal });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? '话题加载失败');
      if (signal?.aborted) return;
      setTopics(j.topics);
      setBuildStatus(j.build);
      setError(null);
    } catch (e) {
      if (!signal?.aborted) setError(e instanceof Error ? e.message : '话题加载失败');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setLoading(true);
      setInfo(undefined);
      void reload(controller.signal);
    });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    if (!selected) {
      return;
    }
    let cancelled = false;
    (async () => {
      const r = await fetch(`/api/topics/${selected}`);
      const j = await r.json();
      if (!cancelled && j.ok) {
        setDetail({
          topic: {
            id: j.id,
            date: j.date,
            title: j.title,
            summary: j.summary,
            message_count: j.message_count,
            group_count: j.group_count,
          },
          messages: j.messages,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const selectedDetail = selected ? detail : null;

  const build = useCallback(async () => {
    if (!buildStatus?.enabled || busy) return;
    setBusy(true);
    setInfo('开始分析当日讨论…');
    try {
      const r = await fetch('/api/topics/build', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ date }),
      });
      if (!r.ok || !r.body) {
        const failure = await r.json().catch(() => null);
        throw new Error(failure?.error ?? `话题构建失败（${r.status}）`);
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 2);
          if (!chunk.startsWith('data:')) continue;
          try {
            const evt = JSON.parse(chunk.slice(5).trim());
            if (evt.type === 'start') {
              setInfo(`${date} · 开始构建话题…`);
            } else if (evt.type === 'load') {
              setInfo(evt.message ?? '加载当日消息…');
            } else if (evt.type === 'llm' && evt.done !== undefined) {
              setInfo(`AI 分析 ${evt.done}/${evt.total}`);
            } else if (evt.type === 'save' && evt.done !== undefined) {
              setInfo(`保存话题 ${evt.done}/${evt.total} · ${evt.message ?? ''}`);
            } else if (evt.type === 'finished' || evt.type === 'done') {
              setInfo(`完成 · ${evt.topics ?? evt.count ?? 0} 个话题`);
            } else if (evt.type === 'error') {
              setInfo('构建失败：' + evt.error);
            } else if (evt.message) {
              setInfo(evt.message);
            }
          } catch {}
        }
      }
    } catch (e) {
      setInfo('构建失败：' + (e instanceof Error ? e.message : '请稍后重试'));
    } finally {
      setBusy(false);
      reload();
    }
  }, [date, reload, buildStatus, busy]);

  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-soft)] bg-[var(--chrome-bg)] px-6 py-3 backdrop-blur">
          <div>
            <div className="report-kicker">Cross-Group Topics</div>
            <div className="flex items-center gap-2 text-[15px] font-semibold">
              <Sparkles size={16} className="text-[var(--accent)]" />
              话题雷达 · 跨群聚合
            </div>
            <div className="mt-0.5 text-[11px] text-[var(--text-3)]">
              {info ?? (loading ? '加载话题中…' : buildStatus?.enabled === false ? 'AI 话题分析尚未启用' : `${date} · ${topics.length} 个话题`)}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="control-surface flex items-center gap-1.5 rounded-md px-2.5 py-1.5">
              <Calendar size={13} className="text-[var(--text-3)]" />
              <input
                type="date"
                aria-label="话题日期"
                disabled={busy}
                value={date}
                onChange={(e) => { if (e.target.value) { setDate(e.target.value); setSelected(null); setDetail(null); } }}
                className="theme-date-input bg-transparent text-[12px] outline-none"
              />
            </div>
            <button className={`btn ${busy ? 'btn-warn' : 'btn-primary'}`} onClick={build} disabled={busy || loading || !buildStatus?.enabled} title={buildStatus?.disabledReason ?? undefined}>
              <RefreshCw size={13} className={busy ? 'animate-spin' : ''} />
              <span>{busy ? '构建中…' : '构建话题'}</span>
            </button>
          </div>
        </div>

        {buildStatus?.enabled === false && <div role="status" className="border-b border-[var(--border-soft)] bg-[var(--accent-soft)] px-6 py-4">
          <div className="text-[13px] font-medium">AI 话题分析尚未启用</div>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-2)]">话题雷达会把各个群的相关讨论合并成话题，并生成标题、摘要和原消息入口。开启后会将筛选后的群聊消息提交给 AI 服务分析。</p>
        </div>}
        {error && <div role="alert" className="bg-[var(--danger-soft)] px-6 py-3 text-[12px] text-[var(--danger)]">{error}<button className="ml-3 underline" onClick={() => void reload()} disabled={busy}>重试</button></div>}

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden xl:grid-cols-[420px_minmax(0,1fr)]">
          <div className="overflow-y-auto border-r border-[var(--border-soft)] p-4">
            {topics.length === 0 ? (
              <div className="py-16 text-center text-[12px] text-[var(--text-3)]">
                {loading ? '加载话题中…' : busy ? '正在分析当日讨论…' : buildStatus?.enabled === false ? '尚未生成话题，需要先启用 AI 分析' : '当日暂无话题，点击“构建话题”开始分析'}
              </div>
            ) : (
              <div className="space-y-2">
                {topics.map((t) => (
                  <button
                    key={t.id}
                    className={`card w-full p-4 text-left transition-colors ${
                      selected === t.id ? 'border-[rgba(125,211,168,0.48)] bg-[var(--surface-2)]' : 'hover:bg-[var(--surface-2)]'
                    }`}
                    onClick={() => {
                      setDetail(null);
                      setSelected(t.id);
                    }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-[14px] font-semibold text-[var(--text)]">{t.title}</div>
                        {t.summary && (
                          <div className="mt-1 line-clamp-2 text-[11px] text-[var(--text-3)]">
                            {t.summary}
                          </div>
                        )}
                      </div>
                      <div className="text-right text-[10px] text-[var(--text-3)] shrink-0">
                        <div className="font-semibold text-[var(--accent)]">{t.message_count}</div>
                        <div>{t.group_count} 群</div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="overflow-y-auto p-5">
            {!selectedDetail ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-[12px] text-[var(--text-3)]">
                <span>{buildStatus?.enabled === false && topics.length === 0 ? '群聊同步和统计可继续正常使用' : '选择一个话题查看跨群讨论'}</span>
                {buildStatus?.enabled === false && topics.length === 0 && <Link href="/groups" className="btn">查看群聊</Link>}
              </div>
            ) : (
              <div>
                <div className="mb-2 text-[18px] font-semibold">{selectedDetail.topic.title}</div>
                {selectedDetail.topic.summary && (
                  <div className="mb-4 text-[13px] leading-relaxed text-[var(--text-2)]">
                    {selectedDetail.topic.summary}
                  </div>
                )}
                <div className="mb-4 flex gap-4 text-[11px] text-[var(--text-3)]">
                  <span>消息：{selectedDetail.topic.message_count}</span>
                  <span>跨群：{selectedDetail.topic.group_count}</span>
                  <span>日期：{selectedDetail.topic.date}</span>
                </div>

                <div className="space-y-2">
                  {selectedDetail.messages.map((m) => (
                    <div
                      key={`${m.chatroom_id}-${m.local_id}`}
                      className="card p-3 text-[12px]"
                    >
                      <div className="flex items-center justify-between text-[11px] text-[var(--text-3)]">
                        <span>
                          <Link
                            href={`/groups/${encodeURIComponent(m.chatroom_id)}?date=${selectedDetail.topic.date}`}
                            className="text-[var(--accent)] hover:underline"
                          >
                            {m.chat_name}
                          </Link>
                          {' · '}
                          <span className="font-medium text-[var(--text-2)]">{m.sender}</span>
                        </span>
                        <span className="tabular-nums">{m.time?.slice(11) ?? ''}</span>
                      </div>
                      <div className="mt-1.5 text-[var(--text)]">
                        <MessageContent content={m.content} chatroomId={m.chatroom_id} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
