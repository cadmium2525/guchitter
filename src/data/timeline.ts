import type { Post } from './posts';

export type TimelineMode = 'newest' | 'random';

export function createTimelineSeed(): string {
  const values = crypto.getRandomValues(new Uint32Array(4));
  return Array.from(values, (value) => value.toString(16).padStart(8, '0')).join('');
}

function compareIds(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/** A fixed seed and post id give each post a stable shuffle priority. */
function randomPriority(seed: string, id: string): number {
  const input = `${seed.length}:${seed}${id}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash = Math.imul(hash ^ input.charCodeAt(index), 16777619);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

export function orderTimeline(posts: readonly Post[], mode: TimelineMode, seed: string): Post[] {
  if (mode === 'newest') {
    return [...posts].sort((a, b) => b.createdAt - a.createdAt || compareIds(a.id, b.id));
  }

  return posts
    .map((post) => ({ post, priority: randomPriority(seed, post.id) }))
    .sort((a, b) => a.priority - b.priority || compareIds(a.post.id, b.post.id))
    .map(({ post }) => post);
}
