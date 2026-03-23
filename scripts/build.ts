import { build } from 'esbuild';
import { mkdirSync } from 'fs';

mkdirSync('plugin/scripts', { recursive: true });

const hooks = [
  'session-start',
  'user-prompt-submit',
  'post-tool-use',
  'stop',
];

for (const hook of hooks) {
  await build({
    entryPoints: [`src/hooks/${hook}.ts`],
    bundle: true,
    outfile: `plugin/scripts/${hook}.js`,
    platform: 'node',
    target: 'esnext',
    format: 'esm',
    minify: false,
    external: ['bun:sqlite'],
    banner: { js: '#!/usr/bin/env bun' },
  });
}

console.log(`Built ${hooks.length} hooks to plugin/scripts/`);
