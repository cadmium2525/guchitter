import { describe, expect, it, vi } from 'vitest';
import type { Post } from './posts';
import { createTimelineSeed, orderTimeline } from './timeline';

function post(id: string, createdAt = 1): Post {
  return { id, createdAt, updatedAt: createdAt, body: id, tags: [], imageIds: [], angerCount: '0' };
}

const posts = Array.from({ length: 24 }, (_, index) => post(`post-${index}`, index));
const ids = (entries: readonly Post[]) => entries.map(({ id }) => id);

describe('timeline ordering', () => {
  it('orders newest first, breaking equal timestamps deterministically by id', () => {
    const entries = [post('z', 10), post('b', 20), post('a', 20), post('old', 1)];
    expect(ids(orderTimeline(entries, 'newest', 'seed'))).toEqual(['a', 'b', 'z', 'old']);
    expect(ids(orderTimeline([...entries].reverse(), 'newest', 'another-seed')))
      .toEqual(['a', 'b', 'z', 'old']);
  });

  it.each(['newest', 'random'] as const)('preserves all posts without mutating input in %s mode', (mode) => {
    const entries = Object.freeze(posts.map((entry) => Object.freeze({ ...entry })));
    const before = ids(entries);
    const result = orderTimeline(entries, mode, 'seed');
    expect(result).not.toBe(entries);
    expect(ids(entries)).toEqual(before);
    expect(ids(result).sort()).toEqual([...before].sort());
    expect(new Set(ids(result)).size).toBe(entries.length);
    expect(result.every((entry) => entries.includes(entry))).toBe(true);
    expect(orderTimeline([], mode, 'seed')).toEqual([]);
  });

  it('keeps random order stable across rerenders, input orders, edits, and anger taps', () => {
    const expected = ids(orderTimeline(posts, 'random', 'session-seed'));
    const edited = posts.map((entry, index) => ({
      ...entry,
      body: `edited ${entry.body}`,
      tags: ['変更'],
      angerCount: `${index + 999}`,
      updatedAt: entry.updatedAt + 999,
    })).reverse();
    expect(ids(orderTimeline(posts, 'random', 'session-seed'))).toEqual(expected);
    expect(ids(orderTimeline(edited, 'random', 'session-seed'))).toEqual(expected);
  });

  it('preserves surviving relative order when posts are deleted or added', () => {
    const expected = ids(orderTimeline(posts, 'random', 'session-seed'));
    const surviving = posts.filter((_, index) => index % 3 !== 0);
    const survivingIds = new Set(ids(surviving));
    const withAdded = [...surviving, post('new-post', 1000), post('another-new-post', 1001)];
    expect(ids(orderTimeline(surviving, 'random', 'session-seed')))
      .toEqual(expected.filter((id) => survivingIds.has(id)));
    expect(ids(orderTimeline(withAdded, 'random', 'session-seed')).filter((id) => survivingIds.has(id)))
      .toEqual(expected.filter((id) => survivingIds.has(id)));
  });

  it('produces different arrangements for different seeds', () => {
    const arrangements = ['first', 'second', 'third', 'fourth', 'fifth']
      .map((seed) => ids(orderTimeline(posts, 'random', seed)).join(','));
    expect(new Set(arrangements).size).toBe(arrangements.length);
    expect(arrangements[0]).not.toBe(ids(posts).join(','));
  });

  it('creates a seed from local random bytes', () => {
    const random = vi.spyOn(crypto, 'getRandomValues').mockImplementationOnce((values) => {
      (values as Uint32Array).set([0, 1, 0x12345678, 0xffffffff]);
      return values;
    });
    try {
      expect(createTimelineSeed()).toBe('000000000000000112345678ffffffff');
      expect(random).toHaveBeenCalledOnce();
      expect(random.mock.calls[0][0]).toBeInstanceOf(Uint32Array);
    } finally {
      random.mockRestore();
    }
  });
});
