import assert from 'node:assert/strict';

process.env.SCHEDULER_ADMIN_PASSWORD = 'correct horse battery staple';
const { handler, config } = await import('../api/maintenance.mjs');
const request = password => ({
  httpMethod: 'POST',
  headers: { 'x-nf-client-connection-ip': '203.0.113.7' },
  body: JSON.stringify({ action: 'verify', password }),
});

for (let i = 0; i < 5; i += 1) {
  const response = await handler(request('wrong'));
  assert.equal(response.statusCode, 401);
}
const blocked = await handler(request('wrong'));
assert.equal(blocked.statusCode, 429);
assert.equal(Number(blocked.headers['retry-after']) > 0, true);
assert.deepEqual(config.path, ['/api/maintenance', '/.api/maintenance']);
assert.equal(config.rateLimit.windowLimit, 20);
console.log('maintenance rate limit OK');
