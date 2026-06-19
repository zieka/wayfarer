import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { estimateTokens, getBudget, fitToBudget, toFtsQuery } from '../src/retrieve';

describe('estimateTokens', () => {
  it('is chars/4 rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('getBudget', () => {
  const ENV_KEY = 'WAYFARER_CONTEXT_TOKEN_BUDGET';
  let original: string | undefined;
  beforeEach(() => { original = process.env[ENV_KEY]; });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it('defaults to 1200 when env unset', () => {
    delete process.env.WAYFARER_CONTEXT_TOKEN_BUDGET;
    expect(getBudget()).toBe(1200);
  });
  it('honors a valid override', () => {
    process.env.WAYFARER_CONTEXT_TOKEN_BUDGET = '600';
    expect(getBudget()).toBe(600);
    delete process.env.WAYFARER_CONTEXT_TOKEN_BUDGET;
  });
  it('falls back to 1200 on invalid override', () => {
    process.env.WAYFARER_CONTEXT_TOKEN_BUDGET = 'nope';
    expect(getBudget()).toBe(1200);
    delete process.env.WAYFARER_CONTEXT_TOKEN_BUDGET;
  });
});

describe('fitToBudget', () => {
  const size = (n: number) => n;
  it('returns [] for empty input', () => {
    expect(fitToBudget<number>([], 100, size)).toEqual([]);
  });
  it('keeps all when they fit', () => {
    expect(fitToBudget([10, 20, 30], 100, size)).toEqual([10, 20, 30]);
  });
  it('stops before exceeding budget', () => {
    expect(fitToBudget([40, 40, 40], 100, size)).toEqual([40, 40]);
  });
  it('always returns at least the first item even if it exceeds budget', () => {
    expect(fitToBudget([500, 10], 100, size)).toEqual([500]);
  });
  it('includes a zero-cost item at exactly the budget but stops before exceeding', () => {
    expect(fitToBudget([60, 40, 0], 100, size)).toEqual([60, 40, 0]);
    expect(fitToBudget([60, 40, 1], 100, size)).toEqual([60, 40]);
  });
});

describe('toFtsQuery', () => {
  it('returns empty string when no usable tokens', () => {
    expect(toFtsQuery('   ?? ')).toBe('');
  });
  it('quotes and OR-joins tokens, dropping duplicates', () => {
    expect(toFtsQuery('Fix the auth auth bug')).toBe('"fix" OR "the" OR "auth" OR "bug"');
  });
  it('neutralizes FTS operators and punctuation', () => {
    // parens/quotes/colons must not reach MATCH as syntax
    expect(toFtsQuery('foo("bar"): baz')).toBe('"foo" OR "bar" OR "baz"');
  });
});
