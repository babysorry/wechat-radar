'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Sidebar from '@/components/Sidebar';
import { ArrowLeft, Sparkles, Check, Tags } from 'lucide-react';

type Group = { id: number; name: string; color: string; emoji: string | null };
type Suggestion = {
  chatroom_id: string;
  name: string;
  summary: string;
  suggested_group_id: number | null;
  suggested_group_name: string | null;
  reason: string;
};

export default function ClassifyPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [picks, setPicks] = useState<Record<string, number | null>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/ai-classify');
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? '分类建议加载失败');
      setGroups(j.groups);
      setSuggestions(j.suggestions);
      const initial: Record<string, number | null> = {};
      for (const s of j.suggestions as Suggestion[]) {
        initial[s.chatroom_id] = s.suggested_group_id;
      }
      setPicks(initial);
    } catch (e) {
      setError(e instanceof Error ? e.message : '分类建议加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const apply = async () => {
    setBusy(true);
    setMsg(null);
    const list = Object.entries(picks)
      .filter(([, v]) => v !== null)
      .map(([chatroom_id, group_id]) => ({ chatroom_id, group_id: group_id as number }));
    if (list.length === 0) {
      setMsg('没有可应用的分类');
      setBusy(false);
      return;
    }
    try {
      const r = await fetch('/api/ai-classify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ picks: list }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? '分类应用失败');
      setMsg(`已应用 ${j.applied} 条`);
      window.dispatchEvent(new Event('categories-updated'));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '分类应用失败');
    } finally {
      setBusy(false);
    }
  };

  const matched = suggestions.filter((s) => picks[s.chatroom_id] !== null).length;

  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-soft)] bg-[var(--chrome-bg)] px-6 py-3 backdrop-blur">
          <div className="flex items-center gap-3">
            <Link href="/" className="text-[var(--text-3)] hover:text-[var(--text)]">
              <ArrowLeft size={16} />
            </Link>
            <div>
              <div className="report-kicker">Classification</div>
              <div className="flex items-center gap-2 text-[15px] font-semibold">
                <Sparkles size={16} className="text-[var(--accent)]" />
                智能分类
              </div>
              <div className="mt-0.5 text-[11px] text-[var(--text-3)]">
                {suggestions.length} 个未分组群 · 已建议 {matched} 条
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/categories" className="btn"><Tags size={13} />分类管理</Link>
            {msg && <span className="text-[12px] text-[var(--text-2)]">{msg}</span>}
            <button className="btn btn-primary" onClick={apply} disabled={busy || loading || matched === 0}>
              <Check size={13} />
              <span>{busy ? '应用中…' : `应用 ${matched} 条`}</span>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <p className="mb-4 text-[12px] text-[var(--text-3)]">根据群名和最近消息的关键词在本机生成建议，选择分类后点击“应用”保存。</p>
          {error && <div role="alert" className="mb-4 rounded bg-[var(--danger-soft)] p-3 text-[12px] text-[var(--danger)]">{error}<button className="ml-3 underline" onClick={() => void load()} disabled={busy || loading}>重新加载</button></div>}
          {loading ? <div className="py-20 text-center text-[12px] text-[var(--text-3)]">加载分类建议中…</div> : error ? null : suggestions.length === 0 ? (
            <div className="py-20 text-center text-[12px] text-[var(--text-3)]">
              所有群都已分类
            </div>
          ) : (
            <div className="card overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead className="border-b border-[var(--border-soft)] text-[11px] uppercase tracking-wider text-[var(--text-3)]">
                  <tr>
                    <th className="px-4 py-2 text-left font-normal">群名</th>
                    <th className="px-4 py-2 text-left font-normal">最近消息</th>
                    <th className="px-4 py-2 text-left font-normal">建议分组</th>
                    <th className="px-4 py-2 text-left font-normal">理由</th>
                  </tr>
                </thead>
                <tbody>
                  {suggestions.map((s) => (
                    <tr
                      key={s.chatroom_id}
                      className="border-b border-[var(--border-soft)] last:border-b-0 hover:bg-[var(--surface-2)]"
                    >
                      <td className="px-4 py-2 max-w-[200px]">
                        <div className="truncate text-[var(--text)]">{s.name}</div>
                      </td>
                      <td className="px-4 py-2 max-w-[260px]">
                        <div className="truncate text-[11px] text-[var(--text-3)]">{s.summary}</div>
                      </td>
                      <td className="px-4 py-2">
                        <select
                          value={picks[s.chatroom_id] ?? ''}
                          onChange={(e) =>
                            setPicks((p) => ({
                              ...p,
                              [s.chatroom_id]: e.target.value ? Number(e.target.value) : null,
                            }))
                          }
                          className="control-surface rounded px-2 py-1 text-[12px] text-[var(--text)] outline-none"
                        >
                          <option value="">— 跳过 —</option>
                          {groups.map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.emoji ?? ''} {g.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-2 text-[11px] text-[var(--text-3)]">{s.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
