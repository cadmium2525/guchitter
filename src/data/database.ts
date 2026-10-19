import Dexie, { type Table } from 'dexie';
import { MAX_IMAGES_PER_POST, validatePreparedImage, type Attachment, type PreparedImage } from './images';
import {
  assertAnger,
  extractTags,
  incrementAnger,
  normalizePostBody,
  type Post,
} from './posts';

export const DATABASE_NAME = 'guchitter-local-diary';
export const DATABASE_SCHEMA_VERSION = 2;

export class DiaryDatabase extends Dexie {
  posts!: Table<Post, string>;
  attachments!: Table<Attachment, string>;

  constructor(name = DATABASE_NAME) {
    super(name);
    this.version(1).stores({
      posts: '&id, createdAt, updatedAt, *tags',
    });
    this.version(DATABASE_SCHEMA_VERSION).stores({
      posts: '&id, createdAt, updatedAt, *tags',
      attachments: '&id, postId',
    }).upgrade(async (transaction) => {
      await transaction.table('posts').toCollection().modify((post: Post) => {
        post.imageIds = [];
      });
    });
  }
}

export const db = new DiaryDatabase();

export function createId(): string {
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
  images: readonly PreparedImage[] = [],
): Promise<Post> {
  assertImageCount(images);
  const normalizedBody = normalizePostBody(body, images.length > 0);
  assertAnger(initialAnger);
  await Promise.all(images.map(validatePreparedImage));
  const now = Date.now();
  const id = createId();
  const attachments = images.map((image): Attachment => ({ ...image, id: createId(), postId: id, createdAt: now }));
  const post: Post = {
    id,
    body: normalizedBody,
    tags: extractTags(normalizedBody),
    imageIds: attachments.map((image) => image.id),
    angerCount: initialAnger,
    createdAt: now,
    updatedAt: now,
  };
  await database.transaction('rw', database.posts, database.attachments, async () => {
    await database.posts.add(post);
    if (attachments.length) await database.attachments.bulkAdd(attachments);
  });
  return post;
}

export async function updatePost(
  id: string,
  body: string,
  database: DiaryDatabase = db,
  images?: readonly (PreparedImage | Attachment)[],
): Promise<void> {
  if (images !== undefined) {
    assertImageCount(images);
    await Promise.all(images.filter((image) => !('id' in image)).map(validatePreparedImage));
  }
  await database.transaction('rw', database.posts, database.attachments, async () => {
    const post = await requirePost(database, id);
    const normalizedBody = normalizePostBody(body, (images ?? post.imageIds).length > 0);
    let imageIds = post.imageIds;
    if (images !== undefined) {
      const seen = new Set<string>();
      const attachments: Attachment[] = [];
      for (const image of images) {
        if ('id' in image) {
          const existing = await database.attachments.get(image.id);
          if (!existing || existing.postId !== id || !post.imageIds.includes(existing.id) || seen.has(existing.id)) {
            throw new Error('添付画像が見つからないか、重複しています。もう一度開いてください。');
          }
          seen.add(existing.id);
          attachments.push(existing);
        } else {
          const attachment = { ...image, id: createId(), postId: id, createdAt: Date.now() };
          seen.add(attachment.id);
          attachments.push(attachment);
        }
      }
      imageIds = attachments.map((image) => image.id);
      const removed = post.imageIds.filter((imageId) => !seen.has(imageId));
      if (removed.length) await database.attachments.bulkDelete(removed);
      if (attachments.length) await database.attachments.bulkPut(attachments);
    }
    await database.posts.put({
      ...post,
      body: normalizedBody,
      tags: extractTags(normalizedBody),
      imageIds,
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
  await database.transaction('rw', database.posts, database.attachments, async () => {
    await requirePost(database, id);
    await database.attachments.where('postId').equals(id).delete();
    await database.posts.delete(id);
  });
}

function assertImageCount(images: readonly unknown[]): void {
  if (!Array.isArray(images) || images.length > MAX_IMAGES_PER_POST) {
    throw new Error(`画像は1投稿に${MAX_IMAGES_PER_POST}枚まで追加できます。`);
  }
}
