import { describe, it, expect } from 'bun:test';
import {
  getCompressThreshold, getOriginalsTtlDays, hardTruncate, compressGeneric,
  MAX_COMPRESSED_CHARS, HEAD_LINES, TAIL_LINES,
  pickStrategy, compressLog, compressField, compressForStorage,
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
  it('preserves both head and tail when combined head+tail exceeds the cap', () => {
    const line = (tag: string, i: number) => `${tag}-${i}-` + 'x'.repeat(120);
    const head = Array.from({ length: HEAD_LINES }, (_, i) => line('HEAD', i));
    const mid = Array.from({ length: 50 }, (_, i) => line('MID', i));
    const tail = Array.from({ length: TAIL_LINES }, (_, i) => line('TAIL', i));
    const out = compressGeneric([...head, ...mid, ...tail].join('\n'));
    expect(out.length).toBeLessThanOrEqual(MAX_COMPRESSED_CHARS + 80);
    expect(out).toContain('HEAD-0-');
    expect(out).toContain(`TAIL-${TAIL_LINES - 1}-`);
    expect(out).toContain('[wayfarer: dropped');
    expect(out).not.toContain('MID-25-');
  });
});

describe('pickStrategy', () => {
  it('routes Bash to the log strategy', () => {
    expect(pickStrategy('Bash', 'plain output')).toBe('log');
  });
  it('routes text with a log signal to the log strategy', () => {
    expect(pickStrategy('Read', 'line one\nERROR: boom\nline three')).toBe('log');
  });
  it('routes plain prose to the generic strategy', () => {
    expect(pickStrategy('Read', 'just some ordinary file contents here')).toBe('generic');
  });
  it('routes keyword-free stack-frame text to the log strategy', () => {
    const trace = 'line one\n    at foo (bar.ts:1)\n    at baz (bar.ts:2)\nline four';
    expect(pickStrategy('Read', trace)).toBe('log');
  });
});

describe('compressLog', () => {
  it('preserves an error line buried in the middle and drops low-signal lines', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `info line ${i}`);
    lines[50] = 'ERROR: something failed';
    const input = lines.join('\n');
    const out = compressLog(input);
    expect(out).toContain('ERROR: something failed');
    expect(out).toContain('[wayfarer: dropped');
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain('info line 0');   // context head kept
    expect(out).toContain('info line 99');  // summary tail kept
    expect(out).not.toContain('info line 40'); // low-signal middle dropped
  });
  it('preserves contiguous stack-frame lines', () => {
    const lines = Array.from({ length: 80 }, (_, i) => `noise ${i}`);
    lines[40] = 'Traceback (most recent call last):';
    lines[41] = '    at foo (bar.ts:1)';
    lines[42] = '    at baz (bar.ts:2)';
    const out = compressLog(lines.join('\n'));
    expect(out).toContain('Traceback (most recent call last):');
    expect(out).toContain('    at foo (bar.ts:1)');
    expect(out).toContain('    at baz (bar.ts:2)');
  });
  it('preserves the last line even when the compressed result exceeds the cap', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `ERROR line ${i} ` + 'z'.repeat(40));
    lines[lines.length - 1] = 'FINAL-TAIL-LINE-MARKER';
    const out = compressLog(lines.join('\n'));
    expect(out.length).toBeLessThanOrEqual(MAX_COMPRESSED_CHARS + 80);
    expect(out).toContain('FINAL-TAIL-LINE-MARKER');
    expect(out).toContain('ERROR line 0');
  });
});

describe('compressField', () => {
  it('passes through text at or under the threshold unchanged', () => {
    const r = compressField('Read', 'small');
    expect(r).toEqual({ text: 'small', compressed: false });
  });
  it('compresses a large multi-line field', () => {
    const input = Array.from({ length: 400 }, (_, i) => `row ${i}`).join('\n');
    const r = compressField('Read', input);
    expect(r.compressed).toBe(true);
    expect(r.text.length).toBeLessThan(input.length);
  });
  it('does not inflate: over-threshold but incompressible stays original', () => {
    // one giant line, length between threshold (2048) and MAX_COMPRESSED_CHARS (4096)
    const input = 'z'.repeat(3000);
    const r = compressField('Read', input);
    expect(r).toEqual({ text: input, compressed: false });
  });
});

describe('compressForStorage', () => {
  it('returns compressed flags for both fields', () => {
    const bigLog = Array.from({ length: 400 }, (_, i) => `ERROR line ${i}`).join('\n');
    const r = compressForStorage('Bash', 'small input', bigLog);
    expect(r.input.compressed).toBe(false);
    expect(r.output.compressed).toBe(true);
    expect(r.output.text.length).toBeLessThan(bigLog.length);
  });
});
