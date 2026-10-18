import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const client = resolve(dist, 'client');

rmSync(dist, { recursive: true, force: true });
mkdirSync(client, { recursive: true });

for (const name of [
  'index.html',
  'index.integrated.html',
  'app.js',
  'api-config.js',
  'extract-client.js',
  'schedule-rules.mjs',
  'app.css',
  'claude-handoff.css',
  'refresh.css',
  'standalone-desktop.html',
  'standalone-mobile.html',
  'robots.txt',
]) cpSync(resolve(root, name), resolve(client, name));
cpSync(resolve(root, 'assets'), resolve(client, 'assets'), { recursive: true });

mkdirSync(resolve(dist, 'server'), { recursive: true });
await build({
  entryPoints: [resolve(root, 'sites/worker.mjs')],
  outfile: resolve(dist, 'server/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire("/worker.js");' },
});
mkdirSync(resolve(dist, '.openai'), { recursive: true });
writeFileSync(resolve(dist, '.openai/hosting.json'), JSON.stringify({
  project_id: 'appgprj_6aa6c36782ac8191811c68e6d71d8ea5',
}, null, 2) + '\n');
