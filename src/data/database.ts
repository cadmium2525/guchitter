import Dexie, { type Table } from 'dexie';
import {
  assertAnger,
  extractTags,
  incrementAnger,
  normalizePostBody,
  type Post,
} from './posts';

export const DATABASE_NAME = 'guchitter-local-diary';
export const DATABASE_SCHEMA_VERSION = 1;

export class DiaryDatabase extends Dexie {
  posts!: Table<Post, string>;

  constructor(name = DATABASE_NAME) {
    super(name);
    this.version(DATABASE_SCHEMA_VERSION).stores({
      posts: '&id, createdAt, updatedAt, *tags',
    });
  }
}

export const db = new DiaryDatabase();

function createId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Safari versions without randomUUID still provide cryptographic random bytes.
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function requirePost(database: DiaryDatabase, id: string): Promise<Post> {
  const post = await database.posts.get(id);
  if (!post) throw new Error('投稿が見つかりません。');
  return post;
}

export async function createPost(
  body: string,
  initialAnger = '0',
  database: DiaryDatabase = db,
): Promise<Post> {
  const normalizedBody = normalizePostBody(body);
  assertAnger(initialAnger);
  const now = Date.now();
  const post: Post = {
    id: createId(),
    body: normalizedBody,
    tags: extractTags(normalizedBody),
    angerCount: initialAnger,
    createdAt: now,
    updatedAt: now,
  };
  await database.transaction('rw', database.posts, () => database.posts.add(post));
  return post;
}

export async function updatePost(
  id: string,
  body: string,
  database: DiaryDatabase = db,
): Promise<void> {
  const normalizedBody = normalizePostBody(body);
  await database.transaction('rw', database.posts, async () => {
    const post = await requirePost(database, id);
    await database.posts.put({
      ...post,
      body: normalizedBody,
      tags: extractTags(normalizedBody),
      updatedAt: Math.max(Date.now(), post.updatedAt),
    });
  });
}

export async function incrementPostAnger(
  id: string,
  database: DiaryDatabase = db,
): Promise<void> {
  // Read and write share one IndexedDB transaction, including across tabs.
  await database.transaction('rw', database.posts, async () => {
    const post = await requirePost(database, id);
    await database.posts.put({
      ...post,
      angerCount: incrementAnger(post.angerCount),
      updatedAt: Math.max(Date.now(), post.updatedAt),
    });
  });
}

export async function deletePost(
  id: string,
  database: DiaryDatabase = db,
): Promise<void> {
  await database.transaction('rw', database.posts, async () => {
    await requirePost(database, id);
    await database.posts.delete(id);
  });
}
