// @vitest-environment node
import 'fake-indexeddb/auto';
import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPost, deletePost, DiaryDatabase, updatePost } from './database';
import { BACKUP_LIMITS, decryptBackup, exportBackup, getRestorePreview, restoreBackup, type VerifiedBackup } from './backup';
import { type PreparedImage } from './images';

const password = '  ふくげん用の秘密🔑Ａ  ';
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1kAAAAASUVORK5CYII=';
let database: DiaryDatabase;
const databases: DiaryDatabase[] = [];
let counter = 0;

function openDatabase(): DiaryDatabase {
  const result = new DiaryDatabase(`guchitter-backup-test-${++counter}`);
  databases.push(result);
  return result;
}

function image(): PreparedImage {
  const blob = new Blob([Buffer.from(pngBase64, 'base64')], { type: 'image/png' });
  return { blob, mimeType: 'image/png', byteLength: blob.size, width: 1, height: 1 };
}

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  database = openDatabase();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(databases.splice(0).map(item => item.delete()));
});

async function envelopeOf(blob: Blob): Promise<Record<string, any>> {
  return JSON.parse(await blob.text()) as Record<string, any>;
}

function headerBytes(envelope: Record<string, any>): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify([
    envelope.format, envelope.formatVersion, envelope.schemaVersion,
    envelope.kdf.name, envelope.kdf.hash, envelope.kdf.iterations, envelope.kdf.salt,
    envelope.cipher.name, envelope.cipher.keyLength, envelope.cipher.tagLength, envelope.cipher.nonce,
  ]));
}

async function keyFor(envelope: Record<string, any>): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000,
    salt: new Uint8Array(Buffer.from(envelope.kdf.salt, 'base64')) }, material,
  { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Create authenticated-but-invalid input, proving payload validation adds to GCM authentication. */
async function rewritePayload(blob: Blob, change: (payload: Record<string, any>) => void, raw?: (json: string) => string): Promise<Blob> {
  const envelope = await envelopeOf(blob);
  const key = await keyFor(envelope);
  const params = { name: 'AES-GCM', iv: new Uint8Array(Buffer.from(envelope.cipher.nonce, 'base64')),
    additionalData: headerBytes(envelope), tagLength: 128 };
  const decrypted = await crypto.subtle.decrypt(params, key, new Uint8Array(Buffer.from(envelope.ciphertext, 'base64')));
  const payload = JSON.parse(new TextDecoder().decode(decrypted)) as Record<string, any>;
  change(payload);
  const json = JSON.stringify(payload);
  const ciphertext = await crypto.subtle.encrypt(params, key, new TextEncoder().encode(raw ? raw(json) : json));
  envelope.ciphertext = Buffer.from(ciphertext).toString('base64');
  return new Blob([JSON.stringify(envelope)], { type: 'application/json' });
}

describe('authenticated complete backup', () => {
  it('round trips raw bodies, ordered tags, arbitrary precision counts, image bytes and dates', async () => {
    const post = await createPost('日記 #育児 ＃Ａ #a', '999999999999999999999999999999999999', database, [image()]);
    const result = await exportBackup(password, database);
    expect(result).toMatchObject({ postCount: 1, imageCount: 1 });
    expect(result.filename).toMatch(/^guchitter-.*\.guchitter-backup$/);
    const envelope = await envelopeOf(result.blob);
    expect(envelope).toMatchObject({ format: 'guchitter-backup', formatVersion: 1, schemaVersion: 2,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000 },
      cipher: { name: 'AES-GCM', keyLength: 256, tagLength: 128 } });
    expect(Buffer.from(envelope.kdf.salt, 'base64')).toHaveLength(16);
    expect(Buffer.from(envelope.cipher.nonce, 'base64')).toHaveLength(12);
    expect(await result.blob.text()).not.toContain(post.body);
    expect(await result.blob.text()).not.toContain(password);
    const verified = await decryptBackup(result.blob, password);
    expect(verified.posts).toEqual([post]);
    expect(verified.createdAt).toBe(result.createdAt);
    expect(verified.attachments).toHaveLength(1);
    expect(Buffer.from(await verified.attachments[0]!.blob.arrayBuffer()).toString('base64')).toBe(pngBase64);
    const target = openDatabase();
    expect(await restoreBackup(verified, target)).toEqual({ addedPosts: 1, addedImages: 1, skippedPosts: 0 });
    expect(await target.posts.toArray()).toEqual([post]);
    expect((await target.attachments.toArray())[0]).toMatchObject({ postId: post.id, width: 1, height: 1 });
    expect(await restoreBackup(verified, target)).toEqual({ addedPosts: 0, addedImages: 0, skippedPosts: 1 });
    expect(await target.attachments.count()).toBe(1);
  });

  it('supports an empty complete backup and generates fresh random salt and nonce each time', async () => {
    const first = await exportBackup(password, database);
    const second = await exportBackup(password, database);
    const a = await envelopeOf(first.blob);
    const b = await envelopeOf(second.blob);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.nonce).not.toBe(b.cipher.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    const verified = await decryptBackup(first.blob, password);
    expect(verified.posts).toEqual([]);
    expect(verified.attachments).toEqual([]);
    expect(await restoreBackup(verified, database)).toEqual({ addedPosts: 0, addedImages: 0, skippedPosts: 0 });
  });

  it('includes image-only posts without fabricating a text body', async () => {
    const post = await createPost('', '0', database, [image()]);
    const backup = await exportBackup(password, database);
    const verified = await decryptBackup(backup.blob, password);
    expect(verified.posts).toEqual([post]);
    expect(verified.posts[0]!.body).toBe('');
    expect(verified.attachments).toHaveLength(1);
  });

  it('uses the exact UTF-8 password without trimming or Unicode normalization', async () => {
    const file = (await exportBackup(password, database)).blob;
    await expect(decryptBackup(file, password.trim())).rejects.toThrow('パスワードが違うか');
    await expect(decryptBackup(file, password.normalize('NFKC'))).rejects.toThrow('パスワードが違うか');
    await expect(decryptBackup(file, password)).resolves.toBeDefined();
  });

  it('rejects a wrong password and byte tampering without writing diary data', async () => {
    const current = await createPost('既存の記録', '12', database);
    const file = (await exportBackup(password, database)).blob;
    await expect(decryptBackup(file, '誤ったパスワード')).rejects.toThrow('パスワードが違うか');
    const envelope = await envelopeOf(file);
    const bytes = Buffer.from(envelope.ciphertext, 'base64');
    bytes[0] = bytes[0]! ^ 1;
    envelope.ciphertext = bytes.toString('base64');
    await expect(decryptBackup(new Blob([JSON.stringify(envelope)]), password)).rejects.toThrow('パスワードが違うか');
    expect(await database.posts.toArray()).toEqual([current]);
  });

  it('authenticates otherwise valid header salt and nonce as AAD', async () => {
    const file = (await exportBackup(password, database)).blob;
    const envelope = await envelopeOf(file);
    const nonce = Buffer.from(envelope.cipher.nonce, 'base64');
    nonce[0] = nonce[0]! ^ 1;
    envelope.cipher.nonce = nonce.toString('base64');
    await expect(decryptBackup(new Blob([JSON.stringify(envelope)]), password)).rejects.toThrow('パスワードが違うか');
    const fresh = await envelopeOf(file);
    // Encrypt without AAD while keeping a supported header: the application must still reject it.
    const key = await keyFor(fresh);
    fresh.ciphertext = Buffer.from(await crypto.subtle.encrypt({ name: 'AES-GCM',
      iv: new Uint8Array(Buffer.from(fresh.cipher.nonce, 'base64')), tagLength: 128 }, key,
    new TextEncoder().encode('{"schemaVersion":2,"exportedAt":1,"posts":[],"attachments":[]}'))).toString('base64');
    await expect(decryptBackup(new Blob([JSON.stringify(fresh)]), password)).rejects.toThrow('パスワードが違うか');
  });

  it('rejects unsupported versions, arbitrary KDF work, unknown keys and invalid Base64 before deriving a key', async () => {
    const file = (await exportBackup(password, database)).blob;
    const original = await envelopeOf(file);
    const derive = vi.spyOn(crypto.subtle, 'deriveKey');
    const variants = [
      { ...original, formatVersion: 99 }, { ...original, schemaVersion: 99 },
      { ...original, kdf: { ...original.kdf, iterations: 6_000_000_000 } },
      { ...original, kdf: { ...original.kdf, hash: 'SHA-1' } },
      { ...original, kdf: { ...original.kdf, secret: 'unknown' } },
      { ...original, cipher: { ...original.cipher, tagLength: 32 } },
      { ...original, extra: true },
      { ...original, ciphertext: `${original.ciphertext}\n` },
      { ...original, kdf: { ...original.kdf, salt: 'AAAAAAAAAAAAAAAAAAAAAB==' } },
    ];
    for (const variant of variants) await expect(decryptBackup(new Blob([JSON.stringify(variant)]), password)).rejects.toThrow();
    expect(derive).not.toHaveBeenCalled();
  });

  it('rejects duplicate JSON keys, including escaped duplicates, before crypto', async () => {
    const file = (await exportBackup(password, database)).blob;
    const json = await file.text();
    const derive = vi.spyOn(crypto.subtle, 'deriveKey');
    await expect(decryptBackup(new Blob([json.replace('{', '{"format":"guchitter-backup",')]), password)).rejects.toThrow();
    await expect(decryptBackup(new Blob([json.replace('{', '{"\\u0066ormat":"guchitter-backup",')]), password)).rejects.toThrow();
    expect(derive).not.toHaveBeenCalled();
  });

  it('rejects an oversized file before reading it and malformed UTF-8/JSON', async () => {
    const large = new Blob(['x']);
    vi.spyOn(large, 'size', 'get').mockReturnValue(BACKUP_LIMITS.fileBytes + 1);
    const read = vi.spyOn(large, 'arrayBuffer');
    await expect(decryptBackup(large, password)).rejects.toThrow('処理上限');
    expect(read).not.toHaveBeenCalled();
    await expect(decryptBackup(new Blob([Uint8Array.of(0xff)]), password)).rejects.toThrow();
    await expect(decryptBackup(new Blob(['{"format":0,}']), password)).rejects.toThrow();
    await expect(decryptBackup(new Blob(['[]']), password)).rejects.toThrow();
  });

  it('checks authenticated payload schema, tags, dates, counters, identifiers and references', async () => {
    await createPost('日記 #育児', '5', database, [image()]);
    const file = (await exportBackup(password, database)).blob;
    const variants: Array<(payload: Record<string, any>) => void> = [
      p => { p.schemaVersion = 1; }, p => { p.extra = true; },
      p => { p.exportedAt = -1; }, p => { p.posts[0].tags = ['別のタグ']; },
      p => { p.exportedAt = Number.MAX_SAFE_INTEGER; },
      p => { p.posts[0].createdAt = 8_640_000_000_000_001; p.posts[0].updatedAt = 8_640_000_000_000_001; },
      p => { p.attachments[0].createdAt = Number.MAX_SAFE_INTEGER; },
      p => { p.posts[0].tags.push('育児'); }, p => { p.posts[0].angerCount = '01'; },
      p => { p.posts[0].updatedAt = p.posts[0].createdAt - 1; },
      p => { p.posts[0].id = ''; }, p => { p.posts.push(p.posts[0]); },
      p => { p.posts[0].imageIds = []; }, p => { p.attachments = []; },
      p => { p.attachments[0].postId = 'missing'; }, p => { p.attachments.push(p.attachments[0]); },
      p => { p.posts[0].imageIds.push(p.posts[0].imageIds[0]); },
    ];
    for (const change of variants) await expect(decryptBackup(await rewritePayload(file, change), password)).rejects.toThrow();
    const duplicateKey = await rewritePayload(file, () => {}, json => json.replace('"exportedAt":', '"schemaVersion":2,"exportedAt":'));
    await expect(decryptBackup(duplicateKey, password)).rejects.toThrow();
    expect(await database.posts.count()).toBe(1);
  }, 20_000);

  it('verifies actual image bytes, SHA-256, MIME, size and encoded dimensions after decryption', async () => {
    await createPost('画像の記録', '0', database, [image()]);
    const file = (await exportBackup(password, database)).blob;
    const variants: Array<(payload: Record<string, any>) => void> = [
      p => { p.attachments[0].sha256 = Buffer.alloc(32).toString('base64'); },
      p => { p.attachments[0].data = `${pngBase64}\n`; },
      p => { p.attachments[0].byteLength += 1; },
      p => { p.attachments[0].mimeType = 'image/jpeg'; },
      p => { p.attachments[0].width = 2; },
      p => { p.attachments[0].width = 2049; },
      p => { p.attachments[0].createdAt = -1; },
    ];
    for (const change of variants) await expect(decryptBackup(await rewritePayload(file, change), password)).rejects.toThrow();
    const fakeRaster = await rewritePayload(file, p => {
      const bytes = Buffer.from('<svg/>');
      p.attachments[0].data = bytes.toString('base64');
      p.attachments[0].byteLength = bytes.length;
      p.attachments[0].sha256 = createHash('sha256').update(bytes).digest('base64');
    });
    await expect(decryptBackup(fakeRaster, password)).rejects.toThrow();
  }, 15_000);

  it('does not report success when snapshot reads, encryption or self-verification fail', async () => {
    vi.spyOn(database.posts, 'toArray').mockRejectedValueOnce(new Error('読み取りに失敗'));
    await expect(exportBackup(password, database)).rejects.toThrow('読み取りに失敗');
    const encrypt = vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValueOnce(new Error('暗号化に失敗'));
    await expect(exportBackup(password, database)).rejects.toThrow('暗号化に失敗');
    encrypt.mockRestore();
    vi.spyOn(crypto.subtle, 'decrypt').mockRejectedValueOnce(new Error('復号に失敗'));
    await expect(exportBackup(password, database)).rejects.toThrow('パスワードが違うか');
    expect(await database.posts.count()).toBe(0);
  });

  it('rejects corrupt persisted records instead of creating an incomplete backup', async () => {
    const post = await createPost('記録 #育児', '0', database, [image()]);
    await database.posts.update(post.id, { tags: ['異なるタグ'] });
    await expect(exportBackup(password, database)).rejects.toThrow();
    await database.posts.update(post.id, { tags: ['育児'] });
    await database.attachments.delete(post.imageIds[0]!);
    await expect(exportBackup(password, database)).rejects.toThrow();
  });

  it('reports processing limits instead of silently dropping an oversized body', async () => {
    const post = await createPost('あ'.repeat(BACKUP_LIMITS.bodyLength + 1), '0', database);
    await expect(exportBackup(password, database)).rejects.toThrow('処理上限');
    expect(await database.posts.get(post.id)).toEqual(post);
  });

  it('preflights aggregate payload size before allocating or encrypting a whole large diary', async () => {
    const body = 'a'.repeat(BACKUP_LIMITS.bodyLength);
    const posts = Array.from({ length: 1_900 }, (_, index) => ({ id: `post-${index}`, body, tags: [], imageIds: [],
      angerCount: '0', createdAt: 1, updatedAt: 1 }));
    vi.spyOn(database.posts, 'toArray').mockResolvedValueOnce(posts);
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    const encrypt = vi.spyOn(crypto.subtle, 'encrypt');
    await expect(exportBackup(password, database)).rejects.toThrow('処理上限');
    expect(encrypt).not.toHaveBeenCalled();
    expect(encode.mock.calls.every(([value]) => (value?.length ?? 0) < BACKUP_LIMITS.bodyLength + 1_000)).toBe(true);
    expect(await database.posts.count()).toBe(0);
  });

  it('rejects aggregate image limits before reading, encoding or hashing any image', async () => {
    const blob = image().blob;
    const read = vi.spyOn(blob, 'arrayBuffer');
    const posts = Array.from({ length: 25 }, (_, index) => ({ id: `post-${index}`, body: '', tags: [], imageIds: [`image-${index}`],
      angerCount: '0', createdAt: 1, updatedAt: 1 }));
    const attachments = posts.map((post, index) => ({ ...image(), blob, id: `image-${index}`, postId: post.id,
      byteLength: BACKUP_LIMITS.imageBytes, createdAt: 1 }));
    vi.spyOn(database.posts, 'toArray').mockResolvedValueOnce(posts);
    vi.spyOn(database.attachments, 'toArray').mockResolvedValueOnce(attachments);
    const hash = vi.spyOn(crypto.subtle, 'digest');
    await expect(exportBackup(password, database)).rejects.toThrow('処理上限');
    expect(read).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
    const backup = await exportBackup(password, database);
    const file = await rewritePayload(backup.blob, payload => {
      payload.posts = posts;
      payload.attachments = attachments.map(({ blob: _blob, ...metadata }) => ({ ...metadata, data: pngBase64,
        sha256: createHash('sha256').update(Buffer.from(pngBase64, 'base64')).digest('base64') }));
    });
    hash.mockClear();
    await expect(decryptBackup(file, password)).rejects.toThrow('処理上限');
    expect(hash).not.toHaveBeenCalled();
  });
});

describe('safe additive restoration', () => {
  it('rejects forged or mutated unverified restoration input', async () => {
    const forged = { createdAt: 1, posts: [], attachments: [] } as unknown as VerifiedBackup;
    await expect(restoreBackup(forged, database)).rejects.toThrow('復号と検証');
    await expect(getRestorePreview(forged, database)).rejects.toThrow('復号と検証');
    await createPost('記録 #タグ', '0', database, [image()]);
    const verified = await decryptBackup((await exportBackup(password, database)).blob, password);
    expect(() => { verified.posts[0]!.body = '偽造'; }).toThrow();
    expect(() => { verified.posts[0]!.tags.push('偽造'); }).toThrow();
    expect(() => { verified.posts[0]!.imageIds.length = 0; }).toThrow();
    expect(() => { verified.attachments[0]!.byteLength = 1; }).toThrow();
  });

  it('preserves unrelated existing posts and previews exact duplicates and conflicts', async () => {
    const duplicate = await createPost('重複する記録', '1', database, [image()]);
    const conflict = await createPost('バックアップ時の記録', '2', database, [image()]);
    const verified = await decryptBackup((await exportBackup(password, database)).blob, password);
    await updatePost(conflict.id, '現在の編集済み記録', database);
    const unrelated = await createPost('バックアップ後の新しい記録', '3', database);
    expect(await getRestorePreview(verified, database)).toMatchObject({ existingPosts: 3, duplicatePosts: 1, conflictingPosts: 1,
      addedPosts: 1, addedImages: 1, requiredBytes: expect.any(Number) });
    const result = await restoreBackup(verified, database);
    expect(result).toEqual({ addedPosts: 1, addedImages: 1, skippedPosts: 1 });
    expect(await database.posts.get(duplicate.id)).toEqual(duplicate);
    expect(await database.posts.get(unrelated.id)).toEqual(unrelated);
    expect((await database.posts.get(conflict.id))!.body).toBe('現在の編集済み記録');
    const restored = (await database.posts.toArray()).find(post => post.body === conflict.body)!;
    expect(restored.id).not.toBe(conflict.id);
    expect(restored.imageIds).not.toEqual(conflict.imageIds);
    const restoredImage = await database.attachments.get(restored.imageIds[0]!);
    expect(restoredImage!.postId).toBe(restored.id);
    expect(await database.attachments.count()).toBe(3);
    expect(await getRestorePreview(verified, database)).toMatchObject({ duplicatePosts: 2, addedPosts: 0, addedImages: 0, requiredBytes: 0 });
    expect(await restoreBackup(verified, database)).toEqual({ addedPosts: 0, addedImages: 0, skippedPosts: 2 });
    expect(await database.posts.count()).toBe(4);
    expect(await database.attachments.count()).toBe(3);
  });

  it('keeps an edited restored copy and creates one stable alternative without repeated duplicates', async () => {
    const original = await createPost('バックアップ時の記録 #育児', '2', database, [image()]);
    const verified = await decryptBackup((await exportBackup(password, database)).blob, password);
    await updatePost(original.id, '現在の記録', database);
    expect(await restoreBackup(verified, database)).toEqual({ addedPosts: 1, addedImages: 1, skippedPosts: 0 });
    const firstCopy = (await database.posts.toArray()).find(post => post.id !== original.id)!;
    expect(firstCopy.id).toMatch(/^restore-post-[a-f0-9]{64}-1$/);
    await updatePost(firstCopy.id, '復元したコピーも編集', database);
    expect(await restoreBackup(verified, database)).toEqual({ addedPosts: 1, addedImages: 1, skippedPosts: 0 });
    const secondCopy = (await database.posts.toArray()).find(post => post.body === original.body)!;
    expect(secondCopy.id).toMatch(/^restore-post-[a-f0-9]{64}-2$/);
    expect((await database.posts.get(firstCopy.id))!.body).toBe('復元したコピーも編集');
    expect(await restoreBackup(verified, database)).toEqual({ addedPosts: 0, addedImages: 0, skippedPosts: 1 });
    // A gap at an earlier stable ID must not cause a third duplicate.
    await deletePost(firstCopy.id, database);
    expect(await restoreBackup(verified, database)).toEqual({ addedPosts: 0, addedImages: 0, skippedPosts: 1 });
    expect(await database.posts.count()).toBe(2);
    expect(await database.attachments.count()).toBe(2);
    expect((await database.posts.get(original.id))!.body).toBe('現在の記録');
  });

  it('preserves distinct original and restored-copy identities from one complete snapshot', async () => {
    const original = await createPost('同じ内容の記録 #育児', '2', database, [image()]);
    const firstBackup = await decryptBackup((await exportBackup(password, database)).blob, password);
    await updatePost(original.id, '現在の編集した記録', database);
    await restoreBackup(firstBackup, database);
    const restoredCopy = (await database.posts.toArray()).find(post => post.id !== original.id)!;
    const copyImage = (await database.attachments.get(restoredCopy.imageIds[0]!))!;
    // Both identities remain valid even if the original later has exactly its earlier content and dates.
    await database.posts.put(original);
    const completeBackup = await decryptBackup((await exportBackup(password, database)).blob, password);
    const target = openDatabase();
    await target.transaction('rw', target.posts, target.attachments, async () => {
      await target.posts.add(restoredCopy);
      await target.attachments.add(copyImage);
    });
    expect(await getRestorePreview(completeBackup, target)).toMatchObject({ duplicatePosts: 1, addedPosts: 1, addedImages: 1 });
    expect(await restoreBackup(completeBackup, target)).toEqual({ addedPosts: 1, addedImages: 1, skippedPosts: 1 });
    expect((await target.posts.toArray()).map(post => post.id).sort()).toEqual([original.id, restoredCopy.id].sort());
    expect(await target.posts.get(original.id)).toEqual(original);
    expect(await target.posts.get(restoredCopy.id)).toEqual(restoredCopy);
    expect(await target.attachments.count()).toBe(2);
    expect(await restoreBackup(completeBackup, target)).toEqual({ addedPosts: 0, addedImages: 0, skippedPosts: 2 });
  });

  it('rechecks changes from another connection after the preview', async () => {
    const post = await createPost('バックアップ時の記録', '5', database);
    const verified = await decryptBackup((await exportBackup(password, database)).blob, password);
    expect((await getRestorePreview(verified, database)).duplicatePosts).toBe(1);
    const other = new DiaryDatabase(database.name);
    try {
      await updatePost(post.id, '別タブで更新した記録', other);
      expect(await restoreBackup(verified, database)).toEqual({ addedPosts: 1, addedImages: 0, skippedPosts: 0 });
      expect((await database.posts.get(post.id))!.body).toBe('別タブで更新した記録');
      expect((await database.posts.toArray()).map(record => record.body).sort()).toEqual(['バックアップ時の記録', '別タブで更新した記録'].sort());
    } finally { other.close(); }
  });

  it('detects image byte conflicts even when IDs and all metadata match', async () => {
    const post = await createPost('画像の記録', '2', database, [image()]);
    const verified = await decryptBackup((await exportBackup(password, database)).blob, password);
    const attachment = (await database.attachments.get(post.imageIds[0]!))!;
    const bytes = new Uint8Array(await attachment.blob.arrayBuffer());
    bytes[45] = bytes[45]! ^ 1;
    await database.attachments.put({ ...attachment, blob: new Blob([bytes], { type: attachment.mimeType }) });
    expect((await getRestorePreview(verified, database)).conflictingPosts).toBe(1);
    expect(await restoreBackup(verified, database)).toEqual({ addedPosts: 1, addedImages: 1, skippedPosts: 0 });
    expect(await database.posts.count()).toBe(2);
    expect(await database.attachments.count()).toBe(2);
    expect(await restoreBackup(verified, database)).toEqual({ addedPosts: 0, addedImages: 0, skippedPosts: 1 });
  });

  it('remaps a colliding image ID belonging to an unrelated current post', async () => {
    const original = await createPost('復元する画像投稿', '0', database, [image()]);
    const verified = await decryptBackup((await exportBackup(password, database)).blob, password);
    const target = openDatabase();
    const current = await createPost('現在の画像投稿', '0', target);
    const incomingImage = verified.attachments[0]!;
    await target.posts.update(current.id, { imageIds: [incomingImage.id] });
    await target.attachments.add({ ...incomingImage, postId: current.id });
    expect(await restoreBackup(verified, target)).toEqual({ addedPosts: 1, addedImages: 1, skippedPosts: 0 });
    const restored = (await target.posts.get(original.id))!;
    expect(restored.imageIds[0]).not.toBe(incomingImage.id);
    expect((await target.attachments.get(incomingImage.id))!.postId).toBe(current.id);
    expect((await target.attachments.get(restored.imageIds[0]!))!.postId).toBe(original.id);
    expect(await restoreBackup(verified, target)).toEqual({ addedPosts: 0, addedImages: 0, skippedPosts: 1 });
    expect(await target.attachments.count()).toBe(2);
  });

  it('rolls back all new posts and images when any attachment write fails', async () => {
    await createPost('追加する記録', '1', database, [image()]);
    await createPost('追加する別の記録', '2', database, [image()]);
    const verified = await decryptBackup((await exportBackup(password, database)).blob, password);
    const target = openDatabase();
    const current = await createPost('消えてはいけない記録', '7', target);
    const realAdd = target.attachments.add.bind(target.attachments);
    let additions = 0;
    vi.spyOn(target.attachments, 'add').mockImplementation((...args) => {
      if (++additions === 2) throw new Error('保存容量がありません');
      return realAdd(...args);
    });
    await expect(restoreBackup(verified, target)).rejects.toThrow('保存容量');
    expect(await target.posts.toArray()).toEqual([current]);
    expect(await target.attachments.count()).toBe(0);
  });
});
