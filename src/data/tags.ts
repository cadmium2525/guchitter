import { extractTags, normalizeTag, type Post } from './posts';

export interface TagUsage {
  /** Display spelling from the first saved occurrence, without a leading #. */
  label: string;
  /** Number of saved posts using this tag. */
  count: number;
}

const tagCollator = new Intl.Collator('ja', { numeric: true });

/** Derive tag history from saved posts; equivalent tags count once per post. */
export function getTagUsage(posts: readonly Pick<Post, 'tags'>[]): TagUsage[] {
  const usage = new Map<string, TagUsage>();
  for (const post of posts) {
    const seen = new Set<string>();
    for (const label of post.tags) {
      const key = normalizeTag(label);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const existing = usage.get(key);
      if (existing) existing.count += 1;
      else usage.set(key, { label, count: 1 });
    }
  }

  return [...usage.values()].sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    const aKey = normalizeTag(a.label);
    const bKey = normalizeTag(b.label);
    const compared = tagCollator.compare(aKey, bKey);
    // The collator can consider different labels equal (for example kana forms).
    return compared || (aKey < bKey ? -1 : aKey > bKey ? 1 : 0);
  });
}

/** Check a complete tag in draft text, using the same matching rules as saving. */
export function hasBodyTag(body: string, tag: string): boolean {
  const key = normalizeTag(tag);
  return extractTags(body).some((label) => normalizeTag(label) === key);
}
