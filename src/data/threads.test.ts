import { describe, expect, it } from 'vitest';
import type { Post } from './posts';
import { buildThread, indexPosts } from './threads';

function post(id: string, createdAt: number, replyToId?: string): Post {
  return { id, createdAt, updatedAt: createdAt, body: id, tags: [], imageIds: [], angerCount: '0', ...(replyToId ? { replyToId } : {}) };
}

describe('reply threads', () => {
  it('shows chronological branches from any reply, excluding independent quotes', () => {
    const posts = [post('root', 1), post('late', 5, 'root'), post('early', 2, 'root'), post('child', 4, 'early'), { ...post('quote', 6), quotePostId: 'root' }];
    expect(buildThread(indexPosts(posts), 'child').map(({ id, depth }) => [id, depth]))
      .toEqual([['root', 0], ['early', 1], ['child', 2], ['late', 1]]);
    expect(buildThread(indexPosts(posts), 'quote').map(entry => entry.id)).toEqual(['quote']);
  });

  it('keeps descendants accessible beneath a deleted-parent placeholder', () => {
    const entries = buildThread(indexPosts([post('reply', 2, 'deleted'), post('child', 3, 'reply')]), 'child');
    expect(entries.map(({ id, depth }) => [id, depth])).toEqual([['deleted', 0], ['reply', 1], ['child', 2]]);
    expect(entries[0]!.post).toBeUndefined();
  });

  it('terminates cycles and self references with one instance of every post', () => {
    const index = indexPosts([post('a', 1, 'b'), post('b', 2, 'a'), post('c', 3, 'b'), post('self', 4, 'self')]);
    expect(buildThread(index, 'c').map(entry => entry.id)).toEqual(['a', 'b', 'c']);
    expect(buildThread(index, 'b').map(entry => entry.id)).toEqual(['a', 'b', 'c']);
    expect(buildThread(index, 'self').map(entry => entry.id)).toEqual(['self']);
  });

  it('handles deep reply chains without recursive stack overflow', () => {
    const posts = Array.from({ length: 12000 }, (_, i) => post(String(i), i, i ? String(i - 1) : undefined));
    const entries = buildThread(indexPosts(posts), '11999');
    expect(entries).toHaveLength(12000);
    expect(entries.at(-1)?.depth).toBe(11999);
  });
});
