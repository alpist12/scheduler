import assert from 'node:assert/strict';
import worker from '../sites/worker.mjs';

const env = {
  NVIDIA_API_KEY: 'test-key',
  ASSETS: { fetch: async () => new Response('local', { status: 200 }) },
};
const health = await worker.fetch(new Request('https://hnubs.example/api/health'), env, {});
assert.equal(health.status, 200);
assert.deepEqual((await health.json()).runtime, 'Sites Worker');

const help = await worker.fetch(new Request('https://hnubs.example/api/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: '도움말' }),
}), env, {});
assert.equal(help.status, 200);
assert.equal((await help.json()).provider, 'local');

const local = await worker.fetch(new Request('https://hnubs.example/app.js'), env, {});
assert.equal(await local.text(), 'local');

console.log('Sites direct API checks passed.');
