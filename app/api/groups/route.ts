import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createGroup, deleteGroup, listGroups, updateGroup } from '@/lib/groups';

export const dynamic = 'force-dynamic';

const GroupSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  emoji: z.string().trim().max(8).optional(),
});
const UpdateSchema = GroupSchema.extend({ id: z.number().int().positive() });

function mutationError(error: unknown) {
  if ((error as { code?: string } | null)?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return NextResponse.json({ ok: false, error: '分类名称已存在，请使用其他名称' }, { status: 409 });
  }
  console.error('Category mutation failed', error);
  return NextResponse.json({ ok: false, error: '保存分类失败，请稍后重试' }, { status: 500 });
}

export async function GET() {
  return NextResponse.json({ ok: true, groups: listGroups() });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = GroupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: '请填写有效的分类名称、颜色和图标' }, { status: 400 });
  }
  try {
    const id = createGroup(parsed.data);
    return NextResponse.json({ ok: true, id }, { status: 201 });
  } catch (e) {
    return mutationError(e);
  }
}

export async function PATCH(req: NextRequest) {
  const parsed = UpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: '请填写有效的分类信息' }, { status: 400 });
  }
  try {
    if (!updateGroup(parsed.data.id, parsed.data)) {
      return NextResponse.json({ ok: false, error: '分类不存在，请刷新页面' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return mutationError(error);
  }
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get('id'));
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: '分类编号无效' }, { status: 400 });
  }
  try {
    if (!deleteGroup(id)) {
      return NextResponse.json({ ok: false, error: '分类不存在，请刷新页面' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return mutationError(error);
  }
}
