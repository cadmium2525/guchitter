import { describe, expect, it } from 'vitest';
import {
  compareAnger,
  extractTags,
  incrementAnger,
  normalizePostBody,
  totalAnger,
} from './posts';

describe('anger values', () => {
  it('increments beyond safe integers without losing any taps', () => {
    expect(incrementAnger('0')).toBe('1');
    expect(incrementAnger('19')).toBe('20');
    expect(incrementAnger('9007199254740992')).toBe('9007199254740993');
    expect(incrementAnger('9'.repeat(1000))).toBe(`1${'0'.repeat(1000)}`);
  });

  it('orders and totals huge counts using every decimal digit', () => {
    expect(compareAnger('10', '9')).toBe(1);
    expect(compareAnger('9007199254740992', '9007199254740993')).toBe(-1);
    expect(compareAnger('23', '23')).toBe(0);
    expect(totalAnger([])).toBe('0');
    expect(totalAnger([{ angerCount: '9007199254740993' }, { angerCount: '7' }]))
      .toBe('9007199254741000');
  });

  it.each(['', '-1', '01', '1.5', '1e4', 'Infinity', ' 3', '３'])('rejects noncanonical value %j', (value) => {
    expect(() => incrementAnger(value)).toThrow();
    expect(() => compareAnger('0', value)).toThrow();
    expect(() => totalAnger([{ angerCount: value }])).toThrow();
  });
});

describe('post text', () => {
  it('extracts Japanese and full-width tags, preserving the first label', () => {
    expect(extractTags('今日は #仕事 #会議 ＃仕事 #Ｃｏｆｆｅｅ #coffee #CAFÉ #cafe\u0301 #ひと休み_2'))
      .toEqual(['仕事', '会議', 'Ｃｏｆｆｅｅ', 'CAFÉ', 'ひと休み_2']);
  });

  it('stops tags at punctuation and supports adjacent tags', () => {
    expect(extractTags('#月曜#朝！＃通勤、#_memo #タグ-続き #')).toEqual(['月曜', '朝', '通勤', '_memo', 'タグ']);
    expect(extractTags('ハッシュタグのない本文')).toEqual([]);
  });

  it('rejects empty content and keeps meaningful whitespace inside the body', () => {
    expect(() => normalizePostBody(' \n\t　')).toThrow();
    expect(normalizePostBody('  一行目\n\n  二行目  ')).toBe('一行目\n\n  二行目');
  });
});
