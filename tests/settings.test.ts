import { describe, it, expect, afterEach } from 'bun:test';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { getSettings, DEFAULT_MODEL } from '../src/settings';

const TEST_SETTINGS_DIR = '/tmp/wayfarer-test-settings';
const TEST_SETTINGS_FILE = `${TEST_SETTINGS_DIR}/settings.json`;

describe('getSettings', () => {
  afterEach(() => {
    try { unlinkSync(TEST_SETTINGS_FILE); } catch {}
  });

  it('returns default model when no settings file', () => {
    const settings = getSettings('/tmp/nonexistent/settings.json');
    expect(settings.model).toBe(DEFAULT_MODEL);
  });

  it('reads model from settings file', () => {
    mkdirSync(TEST_SETTINGS_DIR, { recursive: true });
    writeFileSync(TEST_SETTINGS_FILE, JSON.stringify({ model: 'claude-sonnet-4-5-20250514' }));
    const settings = getSettings(TEST_SETTINGS_FILE);
    expect(settings.model).toBe('claude-sonnet-4-5-20250514');
  });

  it('returns default model for invalid JSON', () => {
    mkdirSync(TEST_SETTINGS_DIR, { recursive: true });
    writeFileSync(TEST_SETTINGS_FILE, 'not json');
    const settings = getSettings(TEST_SETTINGS_FILE);
    expect(settings.model).toBe(DEFAULT_MODEL);
  });

  it('returns default model when model key missing', () => {
    mkdirSync(TEST_SETTINGS_DIR, { recursive: true });
    writeFileSync(TEST_SETTINGS_FILE, JSON.stringify({ other: 'value' }));
    const settings = getSettings(TEST_SETTINGS_FILE);
    expect(settings.model).toBe(DEFAULT_MODEL);
  });
});
