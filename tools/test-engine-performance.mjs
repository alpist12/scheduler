import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

assert.match(source, /const ENGINE_ONLY = .*get\('engine'\) === '1'/);
assert.match(source, /function render\(\) \{\s*engineRevision \+= 1;\s*if \(ENGINE_ONLY\) return;/);
assert.match(source, /snapshot\(\) \{\s*const revision = engineRevision;/);
assert.doesNotMatch(source, /snapshot\(\) \{\s*const revision = JSON\.stringify/);

console.log('engine performance checks passed');
