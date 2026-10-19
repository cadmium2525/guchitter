import { describe, expect, it } from 'vitest';
import { getTagUsage, hasBodyTag } from './tags';

describe('saved tag history', () => {
  it('ranks by the number of saved posts using a tag', () => {
    expect(getTagUsage([
      { tags: ['休日', '仕事'] },
      { tags: ['仕事', '会議'] },
      { tags: ['仕事', '休日'] },
    ])).toEqual([
      { label: '仕事', count: 3 },
      { label: '休日', count: 2 },
      { label: '会議', count: 1 },
    ]);
  });

  it('merges case, full-width, composed accents and kana while preserving first labels', () => {
    expect(getTagUsage([
      { tags: ['Ｃｏｆｆｅｅ', 'coffee', 'COFFEE', 'ｼｺﾞﾄ', 'CAFÉ'] },
      { tags: ['Coffee', 'シゴト', 'cafe\u0301'] },
    ])).toEqual([
      { label: 'CAFÉ', count: 2 },
      { label: 'Ｃｏｆｆｅｅ', count: 2 },
      { label: 'ｼｺﾞﾄ', count: 2 },
    ]);
  });

  it('uses Japanese label order and natural numbers to break frequency ties', () => {
    expect(getTagUsage([{ tags: ['仕事', 'あさ10', 'いらいら', 'あさ2'] }]))
      .toEqual([
        { label: 'あさ2', count: 1 },
        { label: 'あさ10', count: 1 },
        { label: 'いらいら', count: 1 },
        { label: '仕事', count: 1 },
      ]);
    const labels = ['カナ', 'かな'];
    expect(getTagUsage([{ tags: labels }]))
      .toEqual(getTagUsage([{ tags: [...labels].reverse() }]));
  });

  it('does not modify posts or saved tag arrays and returns independent results', () => {
    const tags = ['仕事', '休憩', '仕事'];
    const posts = [{ tags }];
    Object.freeze(tags);
    Object.freeze(posts[0]);
    Object.freeze(posts);
    const result = getTagUsage(posts);
    result[0]!.count = 99;
    expect(tags).toEqual(['仕事', '休憩', '仕事']);
    expect(getTagUsage(posts).every((tag) => tag.count === 1)).toBe(true);
  });

  it('returns no suggestions when no posts have tags', () => {
    expect(getTagUsage([])).toEqual([]);
    expect(getTagUsage([{ tags: [] }])).toEqual([]);
  });
});

describe('draft tag matching', () => {
  it('recognizes an equivalent complete tag with either hash character', () => {
    expect(hasBodyTag('今日は ＃ＣＯＦＦＥＥ #仕事', 'coffee')).toBe(true);
    expect(hasBodyTag('今日は #ｼｺﾞﾄ', 'シゴト')).toBe(true);
    expect(hasBodyTag('今日は #仕事場', '仕事')).toBe(false);
    expect(hasBodyTag('仕事について書く', '仕事')).toBe(false);
    expect(hasBodyTag('', '仕事')).toBe(false);
  });
});
