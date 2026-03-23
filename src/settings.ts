import { readFileSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from './db';

export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
export const SETTINGS_PATH = join(DATA_DIR, 'settings.json');

export interface Settings {
  model: string;
}

export function getSettings(settingsPath: string = SETTINGS_PATH): Settings {
  try {
    const raw = readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_MODEL,
    };
  } catch {
    return { model: DEFAULT_MODEL };
  }
}
