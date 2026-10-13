import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { setFavorite, tagGroup, untagGroup, tagsForChatroom, setChatroomCategory } from '@/lib/groups';

export const dynamic = 'force-dynamic';

const TagSchema = z.object({
  chatroom_id: z.string().min(1),
  group_id: z.number().int().positive(),
  action: z.enum(['add', 'remove']),
});

const FavSchema = z.object({
  chatroom_id: z.string().min(1),
  fav: z.boolean(),
});

const CategorySchema = z.object({
  chatroom_id: z.string().trim().min(1).max(256),
  group_id: z.number().int().positive().nullable(),
});

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const id = url.searchParams.get('chatroom_id');
  if (!id) return NextResponse.json({ ok: false, error: 'chatroom_id required' }, { status: 400 });
  return NextResponse.json({ ok: true, group_ids: tagsForChatroom(id) });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const tag = TagSchema.safeParse(body);
  if (tag.success) {
    if (tag.data.action === 'add') tagGroup(tag.data.chatroom_id, tag.data.group_id);
    else untagGroup(tag.data.chatroom_id, tag.data.group_id);
    return NextResponse.json({ ok: true });
  }
  const fav = FavSchema.safeParse(body);
  if (fav.success) {
    setFavorite(fav.data.chatroom_id, fav.data.fav);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ ok: false, error: 'invalid payload' }, { status: 400 });
}

export async function PATCH(req: NextRequest) {
  const parsed = CategorySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: '请选择有效的分类' }, { status: 400 });
  }
  try {
    const { chatroom_id, group_id } = parsed.data;
    if (!setChatroomCategory(chatroom_id, group_id)) {
      return NextResponse.json({ ok: false, error: '该分类已被删除，请刷新后重新选择' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, group_ids: tagsForChatroom(chatroom_id) });
  } catch (error) {
    console.error('Group category update failed', error);
    return NextResponse.json({ ok: false, error: '分类保存失败，请稍后重试' }, { status: 500 });
  }
}
