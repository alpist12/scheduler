import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const desktop = readFileSync(new URL('../standalone-desktop.html', import.meta.url), 'utf8');
const mobile = readFileSync(new URL('../standalone-mobile.html', import.meta.url), 'utf8');

assert.match(source, /const ENGINE_ONLY = .*get\('engine'\) === '1'/);
assert.match(source, /function render\(\) \{\s*engineRevision \+= 1;\s*if \(ENGINE_ONLY\) return;/);
assert.match(source, /snapshot\(\) \{\s*const revision = engineRevision;/);
assert.doesNotMatch(source, /snapshot\(\) \{\s*const revision = JSON\.stringify/);

for (const ui of [desktop, mobile]) {
  assert.match(ui, /이 조건으로 재배치/);
  assert.match(ui, /memoPlanDays = \(sig, build\)/);
  assert.match(ui, /this\._carryCache \|\|= new Map\(\)/);
  assert.match(ui, /planDaysAll = \(!st\.autoPlanOpen \|\| st\.(?:advancedOpen|planCondOpen) \|\| st\.planCalculating \|\| st\.aiLoadingProject\) \? \[\]/);
  assert.match(ui, /setTimeout\(\(\) => \{/);
  assert.match(ui, /aiLoadingProject/);
}

console.log('engine performance checks passed');
