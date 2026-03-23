import { describe, it, expect } from 'bun:test';
import { parseStdin } from '../src/stdin';

describe('parseStdin', () => {
  it('parses valid JSON', () => {
    const result = parseStdin('{"session_id": "abc", "cwd": "/tmp"}');
    expect(result).toEqual({ session_id: 'abc', cwd: '/tmp' });
  });

  it('returns null for empty input', () => {
    expect(parseStdin('')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseStdin('not json')).toBeNull();
  });
});
