import { describe, it, expect } from 'bun:test';
import {
  getCompressThreshold, getOriginalsTtlDays, hardTruncate, compressGeneric,
  MAX_COMPRESSED_CHARS, HEAD_LINES, TAIL_LINES,
} from '../src/compress';

describe('getCompressThreshold', () => {
  it('defaults to 2048 when unset', () => {
    delete process.env.WAYFARER_COMPRESS_THRESHOLD;
    expect(getCompressThreshold()).toBe(2048);
  });
  it('honors a valid override', () => {
    process.env.WAYFARER_COMPRESS_THRESHOLD = '512';
    expect(getCompressThreshold()).toBe(512);
    delete process.env.WAYFARER_COMPRESS_THRESHOLD;
  });
  it('falls back to 2048 on invalid override', () => {
    process.env.WAYFARER_COMPRESS_THRESHOLD = 'nope';
    expect(getCompressThreshold()).toBe(2048);
    delete process.env.WAYFARER_COMPRESS_THRESHOLD;
  });
});

describe('getOriginalsTtlDays', () => {
  it('defaults to 14 when unset', () => {
    delete process.env.WAYFARER_ORIGINALS_TTL_DAYS;
    expect(getOriginalsTtlDays()).toBe(14);
  });
  it('honors a valid override', () => {
    process.env.WAYFARER_ORIGINALS_TTL_DAYS = '7';
    expect(getOriginalsTtlDays()).toBe(7);
    delete process.env.WAYFARER_ORIGINALS_TTL_DAYS;
  });
  it('falls back to 14 on invalid override', () => {
    process.env.WAYFARER_ORIGINALS_TTL_DAYS = 'x';
    expect(getOriginalsTtlDays()).toBe(14);
    delete process.env.WAYFARER_ORIGINALS_TTL_DAYS;
  });
});

describe('hardTruncate', () => {
  it('returns text unchanged when within the cap', () => {
    const s = 'short';
    expect(hardTruncate(s)).toBe(s);
  });
  it('slices to the cap and appends a marker when over', () => {
    const s = 'x'.repeat(MAX_COMPRESSED_CHARS + 500);
    const out = hardTruncate(s);
    expect(out.length).toBeLessThan(s.length);
    expect(out).toContain('[wayfarer: dropped');
    expect(out.startsWith('x'.repeat(100))).toBe(true);
  });
});

describe('compressGeneric', () => {
  it('keeps head + tail lines and inserts a dropped marker', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    const out = compressGeneric(lines.join('\n'));
    expect(out).toContain('line 0');
    expect(out).toContain('line 299');
    expect(out).toContain('[wayfarer: dropped');
    expect(out.length).toBeLessThan(lines.join('\n').length);
    // a middle line is gone
    expect(out).not.toContain('line 150');
  });
  it('char-slices a single giant line via hardTruncate', () => {
    const s = 'y'.repeat(MAX_COMPRESSED_CHARS * 2);
    const out = compressGeneric(s);
    expect(out.length).toBeLessThan(s.length);
    expect(out).toContain('[wayfarer: dropped');
  });
});
