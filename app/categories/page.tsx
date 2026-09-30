'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Sidebar from '@/components/Sidebar';
import { Check, Pencil, Plus, Sparkles, Tags, Trash2, X } from 'lucide-react';

type Category = {
  id: number;
  name: string;
  color: string;
  emoji: string | null;
  classifier_key: string | null;
  member_count: number;
};

const EMPTY_FORM = { name: '', color: '#28745b', emoji: '' };

export default function CategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const formElement = useRef<HTMLFormElement>(null);

  const load = useCallback(async () => {
    const response = await fetch('/api/groups');
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error ?? '分类加载失败');
    setCategories(result.groups);
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      void load()
        .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : '分类加载失败'); })
        .finally(() => { if (!cancelled) setLoading(false); });
    });
    return () => { cancelled = true; };
  }, [load]);

  const resetForm = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  const focusForm = () => {
    formElement.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    nameInput.current?.focus({ preventScroll: true });
  };

  const edit = (category: Category) => {
    setEditingId(category.id);
    setForm({ name: category.name, color: category.color, emoji: category.emoji ?? '' });
    setPendingDelete(null);
    setError(null);
    setNotice(null);
    focusForm();
  };

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.name.trim()) {
      setError('请输入分类名称');
      nameInput.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch('/api/groups', {
        method: editingId === null ? 'POST' : 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...form, ...(editingId === null ? {} : { id: editingId }) }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error ?? '保存失败');
      setNotice(editingId === null ? '分类已新增' : '分类已保存');
      resetForm();
      window.dispatchEvent(new Event('categories-updated'));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (category: Category) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/groups?id=${category.id}`, { method: 'DELETE' });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error ?? '删除失败');
      setNotice(`已删除“${category.name}”，聊天记录已保留`);
      setPendingDelete(null);
      if (editingId === category.id) resetForm();
      window.dispatchEvent(new Event('categories-updated'));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-soft)] bg-[var(--chrome-bg)] px-6 py-3 backdrop-blur">
          <div>
            <div className="report-kicker">Categories</div>
            <h1 className="flex items-center gap-2 text-title font-semibold">
              <Tags size={16} className="text-[var(--accent)]" />分类管理
            </h1>
            <p className="mt-0.5 text-meta text-[var(--text-3)]">{categories.length} 个分类 · 按你的习惯整理群聊</p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/classify" className="btn"><Sparkles size={13} />智能分类</Link>
            <button className="btn btn-primary" disabled={busy || loading} onClick={() => {
              resetForm(); setError(null); setNotice(null); setPendingDelete(null); focusForm();
            }}><Plus size={13} />新增分类</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="mx-auto max-w-5xl space-y-4">
            {error && <div role="alert" className="rounded-md bg-[var(--danger-soft)] px-4 py-3 text-body text-[var(--danger)]">
              {error}
              {loading === false && categories.length === 0 && <button className="ml-3 underline" disabled={busy} onClick={() => {
                setError(null); setLoading(true);
                void load().catch((e) => setError(e instanceof Error ? e.message : '分类加载失败')).finally(() => setLoading(false));
              }}>重新加载</button>}
            </div>}
            {notice && <div role="status" className="rounded-md bg-[var(--accent-soft)] px-4 py-3 text-body">{notice}</div>}

            <form ref={formElement} onSubmit={save} className="card scroll-mt-5 p-5">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-section font-semibold">{editingId === null ? '新增分类' : '编辑分类'}</h2>
                {editingId !== null && <button type="button" className="btn" disabled={busy} onClick={resetForm}><X size={13} />取消编辑</button>}
              </div>
              <div className="grid grid-cols-1 items-end gap-4 md:grid-cols-[minmax(0,1fr)_100px_80px_auto]">
                <label className="block text-body text-[var(--text-2)]">
                  分类名称
                  <input ref={nameInput} required maxLength={40} value={form.name} disabled={busy || loading}
                    onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：工作、学习、生活"
                    className="control-surface mt-1.5 block w-full rounded-md px-3 py-2 text-body" />
                </label>
                <label className="block text-body text-[var(--text-2)]">
                  图标（可选）
                  <input maxLength={8} value={form.emoji} disabled={busy || loading} onChange={(e) => setForm({ ...form, emoji: e.target.value })}
                    placeholder="例如：📚" className="control-surface mt-1.5 block w-full rounded-md px-3 py-2 text-body" />
                </label>
                <label className="block text-body text-[var(--text-2)]">
                  分类颜色
                  <input type="color" value={form.color} disabled={busy || loading} onChange={(e) => setForm({ ...form, color: e.target.value })}
                    className="control-surface mt-1.5 block h-[37px] w-full cursor-pointer rounded-md p-1" />
                </label>
                <button type="submit" className="btn btn-primary h-[37px] justify-center" disabled={busy || loading}>
                  <Check size={13} />{busy ? '处理中…' : editingId === null ? '添加分类' : '保存修改'}
                </button>
              </div>
              <p className="mt-3 text-meta leading-relaxed text-[var(--text-3)]">原有分类改名后保留自动匹配规则。新增分类可在智能分类页手动选择。</p>
            </form>

            {loading ? <div className="py-12 text-center text-body text-[var(--text-3)]">加载分类中…</div>
              : categories.length === 0 ? <div className="card px-5 py-12 text-center text-body text-[var(--text-3)]">还没有分类，先添加一个吧。</div>
              : <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                {categories.map((category) => <article key={category.id} className="card min-w-0 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-2)] text-[20px]">
                        {category.emoji || <span className="size-3 rounded-full" style={{ backgroundColor: category.color }} />}
                      </span>
                      <div className="min-w-0">
                        <Link href={`/groups?filter=group&group_id=${category.id}`} className="flex items-center gap-2 text-section font-medium hover:underline">
                          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: category.color }} /><span className="truncate">{category.name}</span>
                        </Link>
                        <p className="mt-1 text-meta text-[var(--text-3)]">{category.classifier_key ? '自动匹配' : '手动分类'} · 已手动归类 {category.member_count} 个群</p>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button className="btn" aria-label={`编辑${category.name}`} disabled={busy} onClick={() => edit(category)}><Pencil size={12} />编辑</button>
                      <button className="btn text-[var(--danger)]" aria-label={`删除${category.name}`} disabled={busy} onClick={() => { setPendingDelete(category.id); setError(null); setNotice(null); }}><Trash2 size={12} />删除</button>
                    </div>
                  </div>
                  {pendingDelete === category.id && <div className="mt-4 rounded-md bg-[var(--danger-soft)] p-3" role="alert">
                    <p className="text-body leading-relaxed">确认删除“{category.name}”？群聊将重新匹配分类或进入未分组，聊天记录会保留。</p>
                    <div className="mt-3 flex gap-2">
                      <button className="btn text-[var(--danger)]" disabled={busy} onClick={() => void remove(category)}>{busy ? '删除中…' : '确认删除'}</button>
                      <button className="btn" disabled={busy} onClick={() => setPendingDelete(null)}>取消</button>
                    </div>
                  </div>}
                </article>)}
              </div>}
          </div>
        </div>
      </main>
    </div>
  );
}
