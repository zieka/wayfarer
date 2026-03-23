import { describe, it, expect } from 'bun:test';
import { formatObservations, parseSummaryResponse } from '../src/summarize';

describe('formatObservations', () => {
  it('formats observations into a compact list', () => {
    const result = formatObservations('fix the auth bug', [
      { tool_name: 'Read', tool_input: 'src/auth.ts', tool_output: 'file contents' },
      { tool_name: 'Edit', tool_input: 'src/auth.ts', tool_output: 'edited' },
    ]);
    expect(result).toContain('fix the auth bug');
    expect(result).toContain('[Read]');
    expect(result).toContain('[Edit]');
    expect(result).toContain('src/auth.ts');
  });

  it('truncates long tool inputs', () => {
    const longInput = 'x'.repeat(500);
    const result = formatObservations('test', [
      { tool_name: 'Bash', tool_input: longInput, tool_output: 'ok' },
    ]);
    expect(result.length).toBeLessThan(600);
  });
});

describe('parseSummaryResponse', () => {
  it('parses valid JSON response', () => {
    const json = JSON.stringify({
      summary: 'Fixed the auth bug',
      files_read: ['src/auth.ts'],
      files_edited: ['src/auth.ts', 'tests/auth.test.ts'],
    });
    const result = parseSummaryResponse(json);
    expect(result.summary).toBe('Fixed the auth bug');
    expect(result.files_read).toBe('src/auth.ts');
    expect(result.files_edited).toBe('src/auth.ts,tests/auth.test.ts');
  });

  it('handles plain text response', () => {
    const result = parseSummaryResponse('Fixed the auth bug by adding expiry check');
    expect(result.summary).toBe('Fixed the auth bug by adding expiry check');
    expect(result.files_read).toBeNull();
    expect(result.files_edited).toBeNull();
  });

  it('handles malformed JSON gracefully', () => {
    const result = parseSummaryResponse('{ broken json');
    expect(result.summary).toBe('{ broken json');
    expect(result.files_read).toBeNull();
    expect(result.files_edited).toBeNull();
  });

  it('handles JSON with missing fields', () => {
    const json = JSON.stringify({ summary: 'Did stuff' });
    const result = parseSummaryResponse(json);
    expect(result.summary).toBe('Did stuff');
    expect(result.files_read).toBeNull();
    expect(result.files_edited).toBeNull();
  });
});
