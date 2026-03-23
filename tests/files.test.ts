import { describe, it, expect } from 'bun:test';
import { extractFilePaths } from '../src/files';

describe('extractFilePaths', () => {
  it('extracts absolute paths', () => {
    const input = '{"file_path": "/Users/kyle/src/auth.ts"}';
    expect(extractFilePaths(input)).toContain('/Users/kyle/src/auth.ts');
  });

  it('extracts relative paths with extensions', () => {
    const input = '{"path": "src/components/Button.tsx"}';
    expect(extractFilePaths(input)).toContain('src/components/Button.tsx');
  });

  it('extracts multiple paths', () => {
    const input = 'Edited src/a.ts and src/b.ts';
    const paths = extractFilePaths(input);
    expect(paths).toContain('src/a.ts');
    expect(paths).toContain('src/b.ts');
  });

  it('returns null for no paths', () => {
    expect(extractFilePaths('just some text')).toBeNull();
  });

  it('deduplicates paths', () => {
    const input = 'src/a.ts and src/a.ts again';
    const paths = extractFilePaths(input);
    expect(paths).toBe('src/a.ts');
  });

  it('handles JSON-stringified tool input', () => {
    const input = JSON.stringify({ file_path: '/tmp/test.py', content: 'print("hello")' });
    expect(extractFilePaths(input)).toContain('/tmp/test.py');
  });
});
