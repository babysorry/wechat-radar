'use client';

import { useEffect, useId, useState } from 'react';

type Category = { id: number; name: string; emoji: string | null };
type Sessions = {
  ok: boolean;
  error?: string;
  categories: Category[];
  groups: Array<{ chatroom_id: string; group_ids: number[] }>;
};

export default function GroupCategorySelect({ chatroomId }: { chatroomId: string }) {
  const selectId = useId();
  const [categories, setCategories] = useState<Category[]>([]);
  const [groupIds, setGroupIds] = useState<number[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      setLoadState('loading');
      setError(null);
      try {
        const [sessionsResponse, tagsResponse] = await Promise.all([
          fetch('/api/sessions', { signal: controller.signal, cache: 'no-store' }),
          fetch(`/api/group-tags?chatroom_id=${encodeURIComponent(chatroomId)}`, { signal: controller.signal, cache: 'no-store' }),
        ]);
        const [sessions, tags] = await Promise.all([
          sessionsResponse.json() as Promise<Sessions>,
          tagsResponse.json() as Promise<{ ok: boolean; group_ids: number[] }>,
        ]);
        if (!sessionsResponse.ok || !sessions.ok || !tagsResponse.ok || !tags.ok) throw new Error('分类加载失败，请重试');
        if (controller.signal.aborted) return;
        setCategories(sessions.categories);
        setGroupIds(sessions.groups.find((group) => group.chatroom_id === chatroomId)?.group_ids ?? tags.group_ids);
        setLoadState('ready');
      } catch (error) {
        if (controller.signal.aborted) return;
        setLoadState('error');
        setError(error instanceof Error ? error.message : '分类加载失败，请重试');
      }
    })();
    return () => controller.abort();
  }, [chatroomId, attempt]);

  async function changeCategory(value: string) {
    if (saving || value === '__multiple__') return;
    const previous = groupIds;
    const groupId = value ? Number(value) : null;
    setGroupIds(groupId === null ? [] : [groupId]);
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const response = await fetch('/api/group-tags', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatroom_id: chatroomId, group_id: groupId }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || '分类保存失败，请重试');
      setGroupIds(result.group_ids);
      setSaved(true);
      window.dispatchEvent(new Event('categories-updated'));
    } catch (error) {
      setGroupIds(previous);
      setError(error instanceof Error ? error.message : '分类保存失败，请重试');
    } finally {
      setSaving(false);
    }
  }

  const value = groupIds.length > 1 ? '__multiple__' : String(groupIds[0] ?? '');
  return (
    <div className="flex flex-wrap items-center gap-2 text-meta">
      <label htmlFor={selectId} className="text-[var(--text-3)]">分类</label>
      <select
        id={selectId}
        aria-label="群分类"
        aria-describedby={`${selectId}-status`}
        value={value}
        disabled={loadState !== 'ready' || saving}
        onChange={(event) => void changeCategory(event.target.value)}
        className="control-surface max-w-[220px] rounded-md px-2 py-1 text-body text-[var(--text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-60"
      >
        <option value="">{loadState === 'loading' ? '加载分类…' : '未分组'}</option>
        {groupIds.length > 1 && <option value="__multiple__" disabled>多个分类（{groupIds.length}）</option>}
        {categories.map((category) => (
          <option key={category.id} value={category.id}>{category.emoji ?? ''} {category.name}</option>
        ))}
      </select>
      <span id={`${selectId}-status`} role="status" className={error ? 'text-[var(--danger)]' : 'text-[var(--text-3)]'}>
        {error ?? (saving ? '保存中…' : saved ? '已保存' : '')}
      </span>
      {loadState === 'error' && <button className="btn px-2 py-1" onClick={() => setAttempt((value) => value + 1)}>重试</button>}
    </div>
  );
}
