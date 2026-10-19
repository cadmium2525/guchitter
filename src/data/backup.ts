import Dexie from 'dexie';
import { db, type DiaryDatabase } from './database';
import { MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, MAX_IMAGES_PER_POST, validatePreparedImage, type Attachment } from './images';
import { assertAnger, extractTags, type Post } from './posts';

const FORMAT = 'guchitter-backup';
const FORMAT_VERSION = 1;
const SCHEMA_VERSION = 2;
const ITERATIONS = 600_000;
const RESTORE_VARIANTS = 100;
const MiB = 1024 * 1024;

/** Processing ceilings, not permission to silently omit any diary data. */
export const BACKUP_LIMITS = Object.freeze({
  fileBytes: 256 * MiB,
  payloadBytes: 180 * MiB,
  imageBytes: MAX_IMAGE_BYTES,
  totalImageBytes: 120 * MiB,
  posts: 100_000,
  attachments: 10_000,
  bodyLength: 100_000,
  idLength: 128,
  tagsPerPost: 256,
  tagLength: 128,
  angerDigits: 1_000_000,
});

interface Envelope {
  format: typeof FORMAT;
  formatVersion: typeof FORMAT_VERSION;
  schemaVersion: typeof SCHEMA_VERSION;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; keyLength: 256; tagLength: 128; nonce: string };
  ciphertext: string;
}

interface SerializedAttachment extends Omit<Attachment, 'blob'> {
  data: string;
  sha256: string;
}

interface Payload {
  schemaVersion: typeof SCHEMA_VERSION;
  exportedAt: number;
  posts: Post[];
  attachments: SerializedAttachment[];
}

/** Immutable, authenticated data. Only objects returned by decryptBackup can be restored. */
export interface VerifiedBackup {
  readonly createdAt: number;
  readonly posts: readonly Post[];
  readonly attachments: readonly Attachment[];
}

export interface RestorePreview {
  existingPosts: number;
  duplicatePosts: number;
  conflictingPosts: number;
  addedPosts: number;
  addedImages: number;
  /** Content-size estimate; IndexedDB's actual storage overhead varies. */
  requiredBytes: number;
}

const verifiedBackups = new WeakSet<VerifiedBackup>();
const encoder = new TextEncoder();
const invalidMessage = 'バックアップの形式またはデータが正しくありません。';
const tooLargeMessage = 'バックアップの処理上限を超えています。データは変更されていません。';

function invalid(): never { throw new Error(invalidMessage); }
function tooLarge(): never { throw new Error(tooLargeMessage); }

function requireCrypto(): Crypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new Error('この環境では暗号化を利用できません。HTTPSの対応ブラウザーで開いてください。');
  }
  return globalThis.crypto;
}

function requirePassword(password: string): void {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('バックアップ用パスワードを入力してください。');
  }
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) invalid();
  return object;
}

function date(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0
    || Number.isNaN(new Date(value).getTime())) invalid();
}

function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0
    || value.trim() !== value || /[\u0000-\u001f]/u.test(value)) invalid();
  if (value.length > BACKUP_LIMITS.idLength) tooLarge();
}

function stringList(value: unknown, maxCount: number, maxLength: number): asserts value is string[] {
  if (!Array.isArray(value)) invalid();
  if (value.length > maxCount) tooLarge();
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) invalid();
    if (item.length > maxLength) tooLarge();
  }
}

/** JSON.parse alone discards duplicate object keys. Reject them before interpreting any metadata. */
function parseStrictJson(text: string): unknown {
  let cursor = 0;
  const whitespace = () => {
    while (cursor < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[cursor]!)) cursor += 1;
  };
  const string = (): string => {
    const start = cursor;
    if (text[cursor++] !== '"') invalid();
    while (cursor < text.length) {
      const char = text[cursor++]!;
      if (char === '"') return text.slice(start, cursor);
      if (char.charCodeAt(0) < 32) invalid();
      if (char === '\\') {
        const escaped = text[cursor++]!;
        if (escaped === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(cursor, cursor + 4))) invalid();
          cursor += 4;
        } else if (!escaped || !'"\\/bfnrt'.includes(escaped)) invalid();
      }
    }
    return invalid();
  };
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const value = (depth: number): void => {
    if (depth > 12) invalid();
    whitespace();
    const char = text[cursor];
    if (char === '"') { string(); return; }
    if (char === '{') {
      cursor += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[cursor] === '}') { cursor += 1; return; }
      while (cursor < text.length) {
        const key = JSON.parse(string()) as string;
        if (keys.has(key)) invalid();
        keys.add(key);
        whitespace();
        if (text[cursor++] !== ':') invalid();
        value(depth + 1);
        whitespace();
        const end = text[cursor++];
        if (end === '}') return;
        if (end !== ',') invalid();
        whitespace();
      }
      invalid();
    }
    if (char === '[') {
      cursor += 1;
      whitespace();
      if (text[cursor] === ']') { cursor += 1; return; }
      while (cursor < text.length) {
        value(depth + 1);
        whitespace();
        const end = text[cursor++];
        if (end === ']') return;
        if (end !== ',') invalid();
      }
      invalid();
    }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, cursor)) { cursor += literal.length; return; }
    }
    number.lastIndex = cursor;
    if (!number.exec(text)) invalid();
    cursor = number.lastIndex;
  };
  try {
    value(0);
    whitespace();
    if (cursor !== text.length) invalid();
    return JSON.parse(text) as unknown;
  } catch { return invalid(); }
}

function toBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let index = 0; index < bytes.length; index += 32_768) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 32_768)));
  }
  return btoa(chunks.join(''));
}

function fromBase64(value: unknown, maximum: number, exact?: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) invalid();
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const length = value.length / 4 * 3 - padding;
  if (length > maximum) tooLarge();
  if (length < 1 || (exact !== undefined && length !== exact)) invalid();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if ((padding === 2 && (alphabet.indexOf(value.at(-3)!) & 15) !== 0)
    || (padding === 1 && (alphabet.indexOf(value.at(-2)!) & 3) !== 0)) invalid();
  let binary: string;
  try { binary = atob(value); } catch { return invalid(); }
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function aad(envelope: Envelope): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify([
    envelope.format, envelope.formatVersion, envelope.schemaVersion,
    envelope.kdf.name, envelope.kdf.hash, envelope.kdf.iterations, envelope.kdf.salt,
    envelope.cipher.name, envelope.cipher.keyLength, envelope.cipher.tagLength, envelope.cipher.nonce,
  ]));
}

function validateEnvelope(value: unknown): { envelope: Envelope; salt: Uint8Array<ArrayBuffer>; nonce: Uint8Array<ArrayBuffer>; ciphertext: Uint8Array<ArrayBuffer> } {
  const top = record(value, ['format', 'formatVersion', 'schemaVersion', 'kdf', 'cipher', 'ciphertext']);
  if (top.format !== FORMAT) invalid();
  if (top.formatVersion !== FORMAT_VERSION || top.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('このバックアップのバージョンには対応していません。アプリを更新してください。');
  }
  const kdf = record(top.kdf, ['name', 'hash', 'iterations', 'salt']);
  const cipher = record(top.cipher, ['name', 'keyLength', 'tagLength', 'nonce']);
  if (kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256' || kdf.iterations !== ITERATIONS
    || cipher.name !== 'AES-GCM' || cipher.keyLength !== 256 || cipher.tagLength !== 128) invalid();
  const salt = fromBase64(kdf.salt, 16, 16);
  const nonce = fromBase64(cipher.nonce, 12, 12);
  const ciphertext = fromBase64(top.ciphertext, BACKUP_LIMITS.payloadBytes + 16);
  if (ciphertext.length <= 16) invalid();
  return { envelope: value as Envelope, salt, nonce, ciphertext };
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const crypto = requireCrypto();
  const passwordBytes = encoder.encode(password);
  try {
    const material = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, material,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally { passwordBytes.fill(0); }
}

function validatePost(value: unknown): Post {
  const post = record(value, ['id', 'body', 'tags', 'angerCount', 'createdAt', 'updatedAt', 'imageIds']);
  identifier(post.id);
  if (typeof post.body !== 'string') invalid();
  if (post.body.length > BACKUP_LIMITS.bodyLength) tooLarge();
  stringList(post.tags, BACKUP_LIMITS.tagsPerPost, BACKUP_LIMITS.tagLength);
  if (JSON.stringify(post.tags) !== JSON.stringify(extractTags(post.body))) invalid();
  if (typeof post.angerCount !== 'string') invalid();
  if (post.angerCount.length > BACKUP_LIMITS.angerDigits) tooLarge();
  try { assertAnger(post.angerCount); } catch { return invalid(); }
  date(post.createdAt);
  date(post.updatedAt);
  if (post.updatedAt < post.createdAt) invalid();
  stringList(post.imageIds, MAX_IMAGES_PER_POST, BACKUP_LIMITS.idLength);
  for (const id of post.imageIds) identifier(id);
  if (new Set(post.imageIds).size !== post.imageIds.length) invalid();
  if (post.body.trim() !== post.body || (!post.body && post.imageIds.length === 0)) invalid();
  return { id: post.id, body: post.body, tags: [...post.tags], angerCount: post.angerCount,
    createdAt: post.createdAt, updatedAt: post.updatedAt, imageIds: [...post.imageIds] };
}

function attachmentMetadata(value: unknown, serialized: boolean): Omit<Attachment, 'blob'> {
  const attachment = record(value, ['id', 'postId', 'mimeType', 'byteLength', 'width', 'height', 'createdAt',
    ...(serialized ? ['data', 'sha256'] : ['blob'])]);
  identifier(attachment.id);
  identifier(attachment.postId);
  if (!['image/webp', 'image/jpeg', 'image/png'].includes(attachment.mimeType as string)) invalid();
  if (typeof attachment.byteLength !== 'number' || !Number.isSafeInteger(attachment.byteLength)
    || attachment.byteLength < 1 || attachment.byteLength > BACKUP_LIMITS.imageBytes) invalid();
  for (const dimension of [attachment.width, attachment.height]) {
    if (typeof dimension !== 'number' || !Number.isSafeInteger(dimension) || dimension < 1 || dimension > MAX_IMAGE_SIDE) invalid();
  }
  date(attachment.createdAt);
  return { id: attachment.id, postId: attachment.postId, mimeType: attachment.mimeType as Attachment['mimeType'],
    byteLength: attachment.byteLength, width: attachment.width as number, height: attachment.height as number,
    createdAt: attachment.createdAt };
}

function validateRelationships(posts: readonly Post[], attachments: readonly Pick<Attachment, 'id' | 'postId'>[]): void {
  const postById = new Map<string, Post>();
  const imageById = new Map<string, Pick<Attachment, 'id' | 'postId'>>();
  for (const post of posts) {
    if (postById.has(post.id)) invalid();
    postById.set(post.id, post);
  }
  for (const image of attachments) {
    if (imageById.has(image.id)) invalid();
    imageById.set(image.id, image);
    const post = postById.get(image.postId);
    if (!post || !post.imageIds.includes(image.id)) invalid();
  }
  for (const post of posts) {
    for (const imageId of post.imageIds) {
      if (imageById.get(imageId)?.postId !== post.id) invalid();
    }
  }
}

function assertTotalImageBytes(images: readonly Pick<Attachment, 'byteLength'>[]): void {
  let total = 0;
  for (const image of images) {
    total += image.byteLength;
    if (total > BACKUP_LIMITS.totalImageBytes) tooLarge();
  }
}

/** Calculate the exact serialized size a record at a time, before allocating the full payload. */
function assertPayloadSize(posts: readonly Post[], images: readonly Omit<Attachment, 'blob'>[], exportedAt: number): void {
  let size = encoder.encode(JSON.stringify({ schemaVersion: SCHEMA_VERSION, exportedAt, posts: [], attachments: [] })).byteLength;
  for (let index = 0; index < posts.length; index += 1) {
    size += encoder.encode(JSON.stringify(posts[index])).byteLength + (index === 0 ? 0 : 1);
    if (size > BACKUP_LIMITS.payloadBytes) tooLarge();
  }
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index]!;
    size += encoder.encode(JSON.stringify({ ...image, data: '', sha256: '' })).byteLength
      + 4 * Math.ceil(image.byteLength / 3) + 44 + (index === 0 ? 0 : 1);
    if (size > BACKUP_LIMITS.payloadBytes) tooLarge();
  }
}

function assertCounts(posts: unknown, attachments: unknown): asserts posts is unknown[] {
  if (!Array.isArray(posts) || !Array.isArray(attachments)) invalid();
  if (posts.length > BACKUP_LIMITS.posts || attachments.length > BACKUP_LIMITS.attachments) tooLarge();
}

async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return toBase64(new Uint8Array(await requireCrypto().subtle.digest('SHA-256', bytes)));
}

async function decodePayload(value: unknown): Promise<VerifiedBackup> {
  const payload = record(value, ['schemaVersion', 'exportedAt', 'posts', 'attachments']);
  if (payload.schemaVersion !== SCHEMA_VERSION) invalid();
  date(payload.exportedAt);
  assertCounts(payload.posts, payload.attachments);
  const posts = payload.posts.map(validatePost);
  const serializedImages = payload.attachments as unknown[];
  const attachments: Attachment[] = [];
  // Check ownership before decoding image bytes, and reject every orphan or missing image.
  const metadata = serializedImages.map(value => attachmentMetadata(value, true));
  assertTotalImageBytes(metadata);
  validateRelationships(posts, metadata);
  for (let index = 0; index < serializedImages.length; index += 1) {
    const serialized = serializedImages[index] as SerializedAttachment;
    const image = metadata[index]!;
    const bytes = fromBase64(serialized.data, BACKUP_LIMITS.imageBytes, image.byteLength);
    fromBase64(serialized.sha256, 32, 32);
    if (await digest(bytes) !== serialized.sha256) invalid();
    const attachment: Attachment = { ...image, blob: new Blob([bytes], { type: image.mimeType }) };
    await validatePreparedImage(attachment);
    attachments.push(attachment);
  }
  for (const post of posts) {
    Object.freeze(post.tags);
    Object.freeze(post.imageIds);
    Object.freeze(post);
  }
  attachments.forEach(attachment => {
    Object.freeze(attachment.blob);
    Object.freeze(attachment);
  });
  const verified = Object.freeze({ createdAt: payload.exportedAt, posts: Object.freeze(posts), attachments: Object.freeze(attachments) });
  verifiedBackups.add(verified);
  return verified;
}

/** Authenticate and validate the entire file before exposing a restoration preview. No DB writes. */
export async function decryptBackup(file: Blob, password: string): Promise<VerifiedBackup> {
  requireCrypto();
  requirePassword(password);
  if (!file || typeof file.arrayBuffer !== 'function' || file.size < 1) invalid();
  if (file.size > BACKUP_LIMITS.fileBytes) tooLarge();
  const envelopeBytes = await file.arrayBuffer();
  if (envelopeBytes.byteLength !== file.size || envelopeBytes.byteLength > BACKUP_LIMITS.fileBytes) invalid();
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(envelopeBytes); } catch { return invalid(); }
  const { envelope, salt, nonce, ciphertext } = validateEnvelope(parseStrictJson(text));
  const key = await deriveKey(password, salt);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await requireCrypto().subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(envelope), tagLength: 128 }, key, ciphertext);
  } catch {
    throw new Error('パスワードが違うか、ファイルが破損しています。');
  }
  if (plaintext.byteLength > BACKUP_LIMITS.payloadBytes) tooLarge();
  try {
    const payloadText = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    return await decodePayload(parseStrictJson(payloadText));
  } finally { new Uint8Array(plaintext).fill(0); }
}

/** Build a complete consistent snapshot and verify our own encrypted output before offering a file. */
export async function exportBackup(password: string, database: DiaryDatabase = db): Promise<{
  blob: Blob; filename: string; postCount: number; imageCount: number; createdAt: number;
}> {
  requireCrypto();
  requirePassword(password);
  const snapshot = await database.transaction('r', database.posts, database.attachments, async () => ({
    posts: await database.posts.toArray(), attachments: await database.attachments.toArray(),
  }));
  assertCounts(snapshot.posts, snapshot.attachments);
  const posts = snapshot.posts.map(validatePost);
  const metadata = snapshot.attachments.map(value => attachmentMetadata(value, false));
  assertTotalImageBytes(metadata);
  validateRelationships(posts, metadata);
  const createdAt = Date.now();
  date(createdAt);
  assertPayloadSize(posts, metadata, createdAt);
  const attachments: SerializedAttachment[] = [];
  for (let index = 0; index < snapshot.attachments.length; index += 1) {
    const image = snapshot.attachments[index]!;
    const info = metadata[index]!;
    await validatePreparedImage(image);
    const bytes = new Uint8Array(await image.blob.arrayBuffer());
    attachments.push({ ...info, data: toBase64(bytes), sha256: await digest(bytes) });
  }
  const payload: Payload = { schemaVersion: SCHEMA_VERSION, exportedAt: createdAt, posts, attachments };
  const plaintext = encoder.encode(JSON.stringify(payload));
  if (plaintext.byteLength > BACKUP_LIMITS.payloadBytes) tooLarge();
  const crypto = requireCrypto();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const envelope: Envelope = {
    format: FORMAT, formatVersion: FORMAT_VERSION, schemaVersion: SCHEMA_VERSION,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: toBase64(salt) },
    cipher: { name: 'AES-GCM', keyLength: 256, tagLength: 128, nonce: toBase64(nonce) }, ciphertext: '',
  };
  try {
    const key = await deriveKey(password, salt);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(envelope), tagLength: 128 }, key, plaintext);
    envelope.ciphertext = toBase64(new Uint8Array(ciphertext));
  } finally { plaintext.fill(0); }
  const blob = new Blob([JSON.stringify(envelope)], { type: 'application/json' });
  if (blob.size > BACKUP_LIMITS.fileBytes) tooLarge();
  await decryptBackup(blob, password);
  const stamp = new Date(createdAt).toISOString().replace(/[:.]/g, '-');
  return { blob, filename: `guchitter-${stamp}.guchitter-backup`, postCount: posts.length, imageCount: attachments.length, createdAt };
}

function requireVerified(verified: VerifiedBackup): void {
  if (!verifiedBackups.has(verified)) throw new Error('復号と検証が完了したバックアップを選び直してください。');
}

function samePost(a: Post, b: Post): boolean {
  return a.id === b.id && a.body === b.body && a.angerCount === b.angerCount && a.createdAt === b.createdAt
    && a.updatedAt === b.updatedAt && JSON.stringify(a.tags) === JSON.stringify(b.tags)
    && JSON.stringify(a.imageIds) === JSON.stringify(b.imageIds);
}

function sameImageMetadata(a: Attachment, b: Attachment): boolean {
  return b.blob instanceof Blob && a.id === b.id && a.postId === b.postId && a.mimeType === b.mimeType && a.byteLength === b.byteLength
    && a.width === b.width && a.height === b.height && a.createdAt === b.createdAt && a.blob.type === b.blob.type && a.blob.size === b.blob.size;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

interface PreparedRestorePost {
  post: Post;
  images: Attachment[];
  seed: string;
}

interface PreparedRestore {
  entries: PreparedRestorePost[];
  binary: Map<string, Uint8Array>;
}

interface RestoreEntry {
  post: Post;
  images: Attachment[];
}

/** Hash incoming bytes and canonical content before opening the write transaction. */
async function prepareRestore(verified: VerifiedBackup): Promise<PreparedRestore> {
  const binary = new Map<string, Uint8Array>();
  const hashes = new Map<string, string>();
  const imageById = new Map(verified.attachments.map(image => [image.id, image]));
  for (const image of verified.attachments) {
    const bytes = new Uint8Array(await image.blob.arrayBuffer());
    binary.set(image.id, bytes);
    hashes.set(image.id, await digest(bytes));
  }
  const entries: PreparedRestorePost[] = [];
  for (const post of verified.posts) {
    const images = post.imageIds.map(id => imageById.get(id)!);
    const fingerprint = encoder.encode(JSON.stringify([
      'guchitter-restore-v1',
      [post.id, post.body, post.tags, post.angerCount, post.createdAt, post.updatedAt, post.imageIds],
      images.map(image => [image.id, image.postId, image.mimeType, image.byteLength, image.width, image.height, image.createdAt, hashes.get(image.id)]),
    ]));
    const hash = new Uint8Array(await requireCrypto().subtle.digest('SHA-256', fingerprint));
    const seed = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
    entries.push({ post, images, seed });
  }
  return { entries, binary };
}

function clonePostId(seed: string, variant: number): string {
  return `restore-post-${seed}-${variant}`;
}

function cloneImageId(seed: string, postVariant: number, index: number, imageVariant: number): string {
  return `restore-image-${seed}-p${postVariant}-i${index}-v${imageVariant}`;
}

function ownImageId(id: string, entry: PreparedRestorePost, postVariant: number, index: number): boolean {
  if (postVariant === 0 && id === entry.images[index]!.id) return true;
  const prefix = `restore-image-${entry.seed}-p${postVariant}-i${index}-v`;
  if (!id.startsWith(prefix)) return false;
  const variant = id.slice(prefix.length);
  return /^(?:0|[1-9][0-9]*)$/.test(variant) && Number(variant) < RESTORE_VARIANTS;
}

async function matchesCandidate(entry: PreparedRestorePost, existing: Post, postVariant: number,
  currentImages: Map<string, Attachment>, binary: Map<string, Uint8Array>, inTransaction: boolean): Promise<boolean> {
  if (!Array.isArray(existing.imageIds) || existing.imageIds.length !== entry.images.length) return false;
  if (!samePost({ ...entry.post, id: existing.id, imageIds: existing.imageIds }, existing)) return false;
  for (let index = 0; index < entry.images.length; index += 1) {
    const id = existing.imageIds[index]!;
    if (!ownImageId(id, entry, postVariant, index)) return false;
    const source = entry.images[index]!;
    const image = currentImages.get(id);
    if (!image || !sameImageMetadata({ ...source, id, postId: existing.id }, image)) return false;
    // Compare the record read by this transaction, including a previously restored clone.
    // Keep the transaction alive for bounded Blob I/O only; all crypto happened beforehand.
    const read = image.blob.arrayBuffer();
    const bytes = new Uint8Array(inTransaction ? await Dexie.waitFor(read, 10_000) : await read);
    if (!sameBytes(binary.get(source.id)!, bytes)) return false;
  }
  return true;
}

/** Shared dry-run/write planner. Generated namespaces identify our copies without comparing
 * unrelated posts that happen to contain the same words, dates, or pictures. */
async function planRestore(prepared: PreparedRestore, posts: Post[], images: Attachment[], inTransaction: boolean): Promise<{
  additions: RestoreEntry[]; summary: RestorePreview;
}> {
  const postById = new Map(posts.map(post => [post.id, post]));
  const imageById = new Map(images.map(image => [image.id, image]));
  const incomingPostIds = new Set(prepared.entries.map(entry => entry.post.id));
  const reservedPostIds = new Set([...postById.keys(), ...incomingPostIds]);
  const reservedImageIds = new Set([...imageById.keys(), ...prepared.entries.flatMap(entry => entry.post.imageIds)]);
  const additions: RestoreEntry[] = [];
  let duplicatePosts = 0;
  let conflictingPosts = 0;
  let addedImages = 0;
  let requiredBytes = 0;
  for (const entry of prepared.entries) {
    let duplicate = false;
    // Search all bounded stable candidates before selecting a free one. A prior copy can
    // still exist when the original or an earlier edited/deleted copy left an ID gap.
    for (let variant = 0; variant <= RESTORE_VARIANTS; variant += 1) {
      const id = variant === 0 ? entry.post.id : clonePostId(entry.seed, variant);
      // A complete snapshot can contain both an original and its earlier restored copy.
      // Each incoming identity must survive even when their content is identical.
      if (variant !== 0 && incomingPostIds.has(id)) continue;
      const existing = postById.get(id);
      if (existing && await matchesCandidate(entry, existing, variant, imageById, prepared.binary, inTransaction)) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) { duplicatePosts += 1; continue; }
    const originalExists = postById.has(entry.post.id);
    let postVariant = 0;
    let id = entry.post.id;
    if (originalExists) {
      conflictingPosts += 1;
      for (postVariant = 1; postVariant <= RESTORE_VARIANTS; postVariant += 1) {
        id = clonePostId(entry.seed, postVariant);
        if (!reservedPostIds.has(id)) break;
      }
      if (postVariant > RESTORE_VARIANTS) throw new Error('復元済みの競合が多いため追加できません。既存データは変更されていません。');
    }
    reservedPostIds.add(id);
    const restoredImages = entry.images.map((image, index): Attachment => {
      let imageId = image.id;
      if (postVariant !== 0 || imageById.has(imageId)) {
        let imageVariant = 0;
        for (; imageVariant < RESTORE_VARIANTS; imageVariant += 1) {
          imageId = cloneImageId(entry.seed, postVariant, index, imageVariant);
          if (!reservedImageIds.has(imageId)) break;
        }
        if (imageVariant === RESTORE_VARIANTS) throw new Error('画像IDの競合が多いため復元できません。既存データは変更されていません。');
      }
      reservedImageIds.add(imageId);
      return { ...image, id: imageId, postId: id };
    });
    const post: Post = { ...entry.post, id, tags: [...entry.post.tags], imageIds: restoredImages.map(image => image.id) };
    additions.push({ post, images: restoredImages });
    requiredBytes += encoder.encode(JSON.stringify(post)).byteLength;
    addedImages += restoredImages.length;
    for (const image of restoredImages) {
      const { blob, ...metadata } = image;
      requiredBytes += blob.size + encoder.encode(JSON.stringify(metadata)).byteLength;
    }
  }
  return { additions, summary: { existingPosts: posts.length, duplicatePosts, conflictingPosts,
    addedPosts: additions.length, addedImages, requiredBytes } };
}

/** Read-only estimate. restoreBackup rechecks duplicates and conflicts against its own transaction. */
export async function getRestorePreview(verified: VerifiedBackup, database: DiaryDatabase = db): Promise<RestorePreview> {
  requireVerified(verified);
  const prepared = await prepareRestore(verified);
  const snapshot = await database.transaction('r', database.posts, database.attachments, async () => ({
    posts: await database.posts.toArray(), images: await database.attachments.toArray(),
  }));
  return (await planRestore(prepared, snapshot.posts, snapshot.images, false)).summary;
}

/** Add-only restoration. A rejected write aborts the entire transaction, preserving current data. */
export async function restoreBackup(verified: VerifiedBackup, database: DiaryDatabase = db): Promise<{
  addedPosts: number; addedImages: number; skippedPosts: number;
}> {
  requireVerified(verified);
  const prepared = await prepareRestore(verified);
  return database.transaction('rw', database.posts, database.attachments, async () => {
    const posts = await database.posts.toArray();
    const images = await database.attachments.toArray();
    const { additions, summary } = await planRestore(prepared, posts, images, true);
    for (const addition of additions) {
      await database.posts.add(addition.post);
      for (const image of addition.images) await database.attachments.add(image);
    }
    return { addedPosts: summary.addedPosts, addedImages: summary.addedImages, skippedPosts: summary.duplicatePosts };
  });
}
