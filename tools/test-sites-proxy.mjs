import assert from 'node:assert/strict';
import worker, { upstreamUrl } from '../sites/worker.mjs';

assert.equal(
  upstreamUrl('https://hnubs.example/api/analysis/jobs/abc?x=1').href,
  'https://testserver111.netlify.app/scheduler/api/analysis/jobs/abc?x=1',
);
assert.equal(
  upstreamUrl('https://hnubs.example/api/maintenance').pathname,
  '/.netlify/functions/maintenance',
);

let proxied;
const originalFetch = globalThis.fetch;
globalThis.fetch = async request => {
  proxied = request;
  return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
};

try {
  const response = await worker.fetch(new Request('https://hnubs.example/api/health'));
  assert.equal(proxied.url, 'https://testserver111.netlify.app/scheduler/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const local = await worker.fetch(new Request('https://hnubs.example/app.js'), {
    ASSETS: { fetch: async () => new Response('local', { status: 200 }) },
  });
  assert.equal(await local.text(), 'local');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('Sites API bridge checks passed.');
