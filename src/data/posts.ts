/** Persisted post format. Decimal strings retain every anger tap without a numeric limit. */
export interface Post {
  id: string;
  body: string;
  tags: string[];
  angerCount: string;
  createdAt: number;
  updatedAt: number;
}

const canonicalAngerPattern = /^(?:0|[1-9][0-9]*)$/;
const tagPattern = /[#＃]([\p{L}\p{N}\p{M}_]+)/gu;

export function assertAnger(value: string): void {
  if (typeof value !== 'string' || !canonicalAngerPattern.test(value)) {
    throw new Error('イライラ値は0以上の整数で指定してください。');
  }
}

/** Compare arbitrary precision nonnegative integer strings without Number coercion. */
export function compareAnger(a: string, b: string): number {
  assertAnger(a);
  assertAnger(b);
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

export function incrementAnger(value: string): string {
  assertAnger(value);
  const digits = value.split('');
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    if (digits[index] !== '9') {
      digits[index] = String(Number(digits[index]) + 1);
      return digits.join('');
    }
    digits[index] = '0';
  }
  return `1${digits.join('')}`;
}

function addAnger(a: string, b: string): string {
  assertAnger(a);
  assertAnger(b);
  const result: string[] = [];
  let carry = 0;
  let aIndex = a.length - 1;
  let bIndex = b.length - 1;
  while (aIndex >= 0 || bIndex >= 0 || carry > 0) {
    const digit = Number(a[aIndex] ?? '0') + Number(b[bIndex] ?? '0') + carry;
    result.push(String(digit % 10));
    carry = digit >= 10 ? 1 : 0;
    aIndex -= 1;
    bIndex -= 1;
  }
  return result.reverse().join('') || '0';
}

export function totalAnger(posts: readonly Pick<Post, 'angerCount'>[]): string {
  return posts.reduce((sum, post) => addAnger(sum, post.angerCount), '0');
}

/** Stable comparison key for search and duplicate detection, retaining display labels. */
export function normalizeTag(tag: string): string {
  return tag.normalize('NFKC').toLowerCase();
}

/** Tags are stored without #. The spelling of the first equivalent tag is preserved. */
export function extractTags(body: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const match of body.matchAll(tagPattern)) {
    const label = match[1];
    if (!label) continue;
    const normalized = normalizeTag(label);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      tags.push(label);
    }
  }
  return tags;
}

export function normalizePostBody(body: string): string {
  if (typeof body !== 'string' || body.trim().length === 0) {
    throw new Error('今の気持ちを入力してください。');
  }
  return body.trim();
}
