import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPost,
  deletePost,
  DiaryDatabase,
  incrementPostAnger,
  updatePost,
} from './database';
import type { PreparedImage } from './images';
import type { Post } from './posts';

function image(): PreparedImage {
  const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1kAAAAASUVORK5CYII='), (value) => value.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'image/png' });
  return { blob, mimeType: 'image/png', width: 1, height: 1, byteLength: blob.size };
}

let database: DiaryDatabase;
let nextDatabase = 0;

beforeEach(() => {
  // fake-indexeddb uses Node structuredClone; use its supported native Blob.
  vi.stubGlobal('Blob', NodeBlob);
  nextDatabase += 1;
  database = new DiaryDatabase(`guchitter-test-${nextDatabase}`);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await database.delete();
  vi.unstubAllGlobals();
});

describe('private diary persistence', () => {
  it('upgrades text-only v1 records in place without changing their contents or dates', async () => {
    const legacy = new Dexie(database.name);
    legacy.version(1).stores({ posts: '&id, createdAt, updatedAt, *tags' });
    const oldPost: Omit<Post, 'imageIds'> = {
      id: 'legacy', body: '昔の #記録', tags: ['記録'], angerCount: '999999999999999999999',
      createdAt: 123, updatedAt: 456,
    };
    await legacy.table('posts').add(oldPost);
    legacy.close();
    expect(await database.posts.get('legacy')).toEqual({ ...oldPost, imageIds: [] });
    expect(await database.attachments.count()).toBe(0);
  });

  it('starts empty and persists new posts through closing and reopening', async () => {
    expect(await database.posts.count()).toBe(0);
    const post = await createPost('  今日の #仕事 は大変  ', '9007199254740993', database);
    expect(post).toMatchObject({
      body: '今日の #仕事 は大変',
      tags: ['仕事'],
      angerCount: '9007199254740993',
    });
    expect(post.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.createdAt).toBe(post.updatedAt);
    const databaseName = database.name;
    database.close();
    database = new DiaryDatabase(databaseName);
    expect(await database.posts.get(post.id)).toEqual(post);
  });

  it('edits the body and tags while preserving the count, id, and original date', async () => {
    const post = await createPost('元の #仕事', '42', database);
    await updatePost(post.id, '編集後の ＃休日 #散歩', database);
    const edited = await database.posts.get(post.id);
    expect(edited).toMatchObject({
      id: post.id,
      body: '編集後の ＃休日 #散歩',
      tags: ['休日', '散歩'],
      angerCount: '42',
      createdAt: post.createdAt,
    });
    expect(edited!.updatedAt).toBeGreaterThanOrEqual(post.updatedAt);
    await deletePost(post.id, database);
    expect(await database.posts.get(post.id)).toBeUndefined();
  });

  it('serializes simultaneous taps, including taps from another connection', async () => {
    const post = await createPost('連打して吐き出す', '9999999999999999999999', database);
    const secondConnection = new DiaryDatabase(database.name);
    try {
      await Promise.all(Array.from({ length: 60 }, (_, index) =>
        incrementPostAnger(post.id, index % 2 ? database : secondConnection)));
      expect((await database.posts.get(post.id))!.angerCount).toBe('10000000000000000000059');
    } finally {
      secondConnection.close();
    }
  });

  it('does not lose a concurrently edited body while processing taps', async () => {
    const post = await createPost('元の気持ち', '2', database);
    await Promise.all([
      incrementPostAnger(post.id, database),
      updatePost(post.id, '編集した #気持ち', database),
      incrementPostAnger(post.id, database),
    ]);
    expect(await database.posts.get(post.id)).toMatchObject({
      body: '編集した #気持ち',
      tags: ['気持ち'],
      angerCount: '4',
    });
  });

  it('rejects invalid input before writing and leaves an existing post intact', async () => {
    await expect(createPost('　 \n', '0', database)).rejects.toThrow();
    await expect(createPost('気持ち', '01', database)).rejects.toThrow();
    expect(await database.posts.count()).toBe(0);
    const post = await createPost('大事な記録', '5', database);
    await expect(updatePost(post.id, '   ', database)).rejects.toThrow();
    expect(await database.posts.get(post.id)).toEqual(post);
  });

  it('reports missing posts instead of treating changes as successful', async () => {
    await expect(updatePost('missing', '編集', database)).rejects.toThrow('投稿が見つかりません');
    await expect(incrementPostAnger('missing', database)).rejects.toThrow('投稿が見つかりません');
    await expect(deletePost('missing', database)).rejects.toThrow('投稿が見つかりません');
  });

  it('propagates storage failures and does not report an unsaved post as successful', async () => {
    vi.spyOn(database.posts, 'add').mockRejectedValueOnce(new Error('保存領域がいっぱいです'));
    await expect(createPost('保存できない記録', '0', database)).rejects.toThrow('保存領域がいっぱい');
    expect(await database.posts.count()).toBe(0);
  });

  it('retains the previous count and reports failure when an increment cannot be stored', async () => {
    const post = await createPost('保存を確認する', '99', database);
    vi.spyOn(database.posts, 'put').mockRejectedValueOnce(new Error('保存に失敗しました'));
    await expect(incrementPostAnger(post.id, database)).rejects.toThrow('保存に失敗しました');
    expect(await database.posts.get(post.id)).toEqual(post);
  });

  it('aborts an increment when the stored count is invalid', async () => {
    const post = await createPost('気持ち', '2', database);
    await database.posts.update(post.id, { angerCount: 'invalid' });
    await expect(incrementPostAnger(post.id, database)).rejects.toThrow();
    expect((await database.posts.get(post.id))!.angerCount).toBe('invalid');
  });

  it('persists image-only posts and every byte through a database reopening', async () => {
    const photo = image();
    const post = await createPost('   ', '123', database, [photo]);
    expect(post.body).toBe('');
    expect(post.imageIds).toHaveLength(1);
    const databaseName = database.name;
    database.close();
    database = new DiaryDatabase(databaseName);
    const attachment = (await database.attachments.get(post.imageIds[0]!))!;
    expect(attachment).toMatchObject({ postId: post.id, mimeType: 'image/png', width: 1, height: 1, byteLength: photo.byteLength });
    expect(new Uint8Array(await attachment.blob.arrayBuffer())).toEqual(new Uint8Array(await photo.blob.arrayBuffer()));
    expect((await database.posts.get(post.id))!.imageIds).toEqual(post.imageIds);
  });

  it('retains images on text edits, atomically replaces selected images, then deletes all related blobs', async () => {
    const post = await createPost('写真 #休日', '5', database, [image(), image()]);
    await updatePost(post.id, '本文だけを編集 #散歩', database);
    expect((await database.posts.get(post.id))!.imageIds).toEqual(post.imageIds);
    const kept = (await database.attachments.get(post.imageIds[1]!))!;
    await updatePost(post.id, '', database, [kept, image()]);
    const edited = (await database.posts.get(post.id))!;
    expect(edited.imageIds[0]).toBe(kept.id);
    expect(edited.imageIds[1]).not.toBe(post.imageIds[0]);
    expect(await database.attachments.get(post.imageIds[0]!)).toBeUndefined();
    expect(await database.attachments.count()).toBe(2);
    await deletePost(post.id, database);
    expect(await database.attachments.count()).toBe(0);
    expect(await database.posts.count()).toBe(0);
  });

  it('rejects corrupt, excess, duplicate or foreign images and does not remove the last content', async () => {
    await expect(createPost('', '0', database, Array.from({ length: 5 }, image))).rejects.toThrow('4枚');
    await expect(createPost('不正', '0', database, [{ ...image(), width: 200 }])).rejects.toThrow();
    expect(await database.posts.count()).toBe(0);
    const first = await createPost('', '0', database, [image()]);
    const second = await createPost('別の投稿', '0', database, [image()]);
    const attachment = (await database.attachments.get(first.imageIds[0]!))!;
    await expect(updatePost(first.id, '', database, [])).rejects.toThrow();
    await expect(updatePost(first.id, '本文', database, [attachment, attachment])).rejects.toThrow('重複');
    await expect(updatePost(second.id, '本文', database, [attachment])).rejects.toThrow('添付画像');
    expect(await database.posts.get(first.id)).toEqual(first);
    expect(await database.posts.get(second.id)).toEqual(second);
    expect(await database.attachments.count()).toBe(2);
  });

  it('rolls back both image and post writes if storage fails during create, edit or delete', async () => {
    vi.spyOn(database.attachments, 'bulkAdd').mockRejectedValueOnce(new Error('画像を保存できません'));
    await expect(createPost('写真', '0', database, [image()])).rejects.toThrow('画像を保存');
    expect(await database.posts.count()).toBe(0);
    expect(await database.attachments.count()).toBe(0);
    const post = await createPost('元の写真', '0', database, [image()]);
    const original = await database.attachments.toArray();
    vi.spyOn(database.posts, 'put').mockRejectedValueOnce(new Error('投稿を保存できません'));
    await expect(updatePost(post.id, '差し替え', database, [image()])).rejects.toThrow('投稿を保存');
    expect(await database.posts.get(post.id)).toEqual(post);
    expect((await database.attachments.toArray()).map((entry) => entry.id)).toEqual(original.map((entry) => entry.id));
    vi.spyOn(database.posts, 'delete').mockRejectedValueOnce(new Error('削除できません'));
    await expect(deletePost(post.id, database)).rejects.toThrow('削除できません');
    expect(await database.posts.get(post.id)).toEqual(post);
    expect((await database.attachments.toArray()).map((entry) => entry.id)).toEqual(original.map((entry) => entry.id));
  });
});
