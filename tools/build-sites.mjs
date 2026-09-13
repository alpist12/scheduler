import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const client = resolve(dist, 'client');

rmSync(dist, { recursive: true, force: true });
mkdirSync(client, { recursive: true });

for (const name of [
  'index.html',
  'index.integrated.html',
  'app.js',
  'schedule-rules.mjs',
  'app.css',
  'claude-handoff.css',
  'refresh.css',
  'standalone-desktop.html',
  'standalone-mobile.html',
]) cpSync(resolve(root, name), resolve(client, name));
cpSync(resolve(root, 'assets'), resolve(client, 'assets'), { recursive: true });

mkdirSync(resolve(dist, 'server'), { recursive: true });
cpSync(resolve(root, 'sites/worker.mjs'), resolve(dist, 'server/index.js'));
mkdirSync(resolve(dist, '.openai'), { recursive: true });
writeFileSync(resolve(dist, '.openai/hosting.json'), JSON.stringify({
  project_id: 'appgprj_6aa6c36782ac8191811c68e6d71d8ea5',
}, null, 2) + '\n');
