import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPost,
  deletePost,
  DiaryDatabase,
  incrementPostAnger,
  updatePost,
} from './database';

let database: DiaryDatabase;
let nextDatabase = 0;

beforeEach(() => {
  nextDatabase += 1;
  database = new DiaryDatabase(`guchitter-test-${nextDatabase}`);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await database.delete();
});

describe('private diary persistence', () => {
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
});
