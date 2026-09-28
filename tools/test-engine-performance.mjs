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
  assert.match(ui, /if \(live\?\.ready && this\.state\.splash\) this\.leaveSplash\(\);/);
}

assert.doesNotMatch(mobile, /quickLinks:/);
assert.match(desktop, /componentDidMount\(\)[\s\S]*?this\.setState\(\{ splash: false \}\);/);
assert.match(mobile, /componentDidMount\(\)[\s\S]*?this\.setState\(\{ splash: false \}\);/);
assert.match(desktop, /const current = window\.parent\?\.HNUBS_MAINT;/);


/* 후보 계산이 같은 질문을 수천 번 되묻던 것들. 하나라도 풀리면 재배치가 다시 10초대로 돌아간다.
   (실측: 3화 16씬 기준 10,488ms → 18ms) */
assert.match(source, /const members = \(\) => \{ freshCache\(\); return revCache\.members \|\|= buildMembers\(\); \};/);
assert.doesNotMatch(source, /const members = \(\) => Object\.fromEntries/);
assert.match(source, /function shootsByDate\(iso\)/);
assert.match(source, /const value = computeRangesOn\(m, iso\);/);
assert.match(source, /shoots: shootsByDate\(iso\), memberIdsOfShoot: shootMemberIds,/);

console.log('engine performance checks passed');
