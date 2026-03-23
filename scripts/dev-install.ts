/**
 * Dev install script: builds hooks and syncs plugin to Claude Code's plugin directory.
 *
 * Usage: bun run dev:install
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

const PLUGIN_NAME = 'wayfarer';
const MARKETPLACE_NAME = 'wayfarer';
const PROJECT_ROOT = join(import.meta.dir, '..');
const PLUGIN_SRC = join(PROJECT_ROOT, 'plugin');
const CLAUDE_DIR = join(homedir(), '.claude');
const PLUGINS_DIR = join(CLAUDE_DIR, 'plugins');
const MARKETPLACE_DIR = join(PLUGINS_DIR, 'marketplaces', MARKETPLACE_NAME);
const CACHE_DIR = join(PLUGINS_DIR, 'cache', MARKETPLACE_NAME, PLUGIN_NAME);

// Read version from plugin.json
const pluginJson = JSON.parse(readFileSync(join(PLUGIN_SRC, '.claude-plugin', 'plugin.json'), 'utf-8'));
const version = pluginJson.version;
const VERSIONED_CACHE_DIR = join(CACHE_DIR, version);

// Step 1: Build hooks
console.log('Building hooks...');
execSync('bun run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });

// Step 2: Sync plugin directory to marketplace location
console.log(`\nSyncing to ${MARKETPLACE_DIR}...`);
mkdirSync(MARKETPLACE_DIR, { recursive: true });
cpSync(PLUGIN_SRC, MARKETPLACE_DIR, { recursive: true });

// Step 3: Sync to cache directory
console.log(`Syncing to cache ${VERSIONED_CACHE_DIR}...`);
mkdirSync(VERSIONED_CACHE_DIR, { recursive: true });
cpSync(PLUGIN_SRC, VERSIONED_CACHE_DIR, { recursive: true });

// Step 4: Register in known_marketplaces.json
const marketplacesFile = join(PLUGINS_DIR, 'known_marketplaces.json');
const marketplaces = existsSync(marketplacesFile)
  ? JSON.parse(readFileSync(marketplacesFile, 'utf-8'))
  : {};

if (!marketplaces[MARKETPLACE_NAME]) {
  marketplaces[MARKETPLACE_NAME] = {
    source: { source: 'directory', path: MARKETPLACE_DIR },
    installLocation: MARKETPLACE_DIR,
    lastUpdated: new Date().toISOString(),
  };
  writeFileSync(marketplacesFile, JSON.stringify(marketplaces, null, 2) + '\n');
  console.log('Registered in known_marketplaces.json');
} else {
  marketplaces[MARKETPLACE_NAME].lastUpdated = new Date().toISOString();
  writeFileSync(marketplacesFile, JSON.stringify(marketplaces, null, 2) + '\n');
  console.log('Updated known_marketplaces.json');
}

// Step 5: Register in installed_plugins.json
const installedFile = join(PLUGINS_DIR, 'installed_plugins.json');
const installed = existsSync(installedFile)
  ? JSON.parse(readFileSync(installedFile, 'utf-8'))
  : { version: 2, plugins: {} };

const pluginKey = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
installed.plugins[pluginKey] = [
  {
    scope: 'user',
    installPath: VERSIONED_CACHE_DIR,
    version,
    installedAt: installed.plugins[pluginKey]?.[0]?.installedAt ?? new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  },
];
writeFileSync(installedFile, JSON.stringify(installed, null, 2) + '\n');
console.log('Registered in installed_plugins.json');

// Step 6: Enable in settings.json
const settingsFile = join(CLAUDE_DIR, 'settings.json');
const settings = existsSync(settingsFile)
  ? JSON.parse(readFileSync(settingsFile, 'utf-8'))
  : {};

if (!settings.enabledPlugins) {
  settings.enabledPlugins = {};
}

if (!settings.enabledPlugins[pluginKey]) {
  settings.enabledPlugins[pluginKey] = true;
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  console.log('Enabled in settings.json');
} else {
  console.log('Already enabled in settings.json');
}

console.log(`\nDone! Wayfarer v${version} installed.`);
console.log('Restart Claude Code to pick up the new plugin.');
