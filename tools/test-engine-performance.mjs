import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const desktop = readFileSync(new URL('../standalone-desktop.html', import.meta.url), 'utf8');
const mobile = readFileSync(new URL('../standalone-mobile.html', import.meta.url), 'utf8');
const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

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
assert.match(index, /firestore\.googleapis\.com\/v1\/projects\/hnubs-2sceduler\/databases\/default\/documents\/settings\/maintenance/);
assert.match(index, /const state = await readMaintStatus\(\);/);
assert.match(index, /window\.hnubsToast = message =>/);
assert.match(index, /aria-live', 'polite'/);
assert.match(index, /HNUBS_LAST_VISIT/);
assert.match(index, /class="boot-brand"/);
assert.doesNotMatch(index, /class="boot-card"/);
assert.match(index, /document\.body\.classList\.add\('app-ready'\)/);
assert.match(index, /Number\(item\.createdAt\) > lastVisit/);
assert.match(source, /createdAt: previous\.createdAt \|\| Date\.now\(\), updatedAt: Date\.now\(\)/);
for (const ui of [desktop, mobile]) assert.match(ui, /window\.parent\.hnubsToast\(message\)/);
assert.match(desktop, /const selectedLive = liveMembers\.find\(m => m\.name === st\.person\);/);
assert.match(mobile, /const selectedMember = liveMembers\.find\(m => m\.name === st\.mPerson\);/);
assert.match(desktop, /확인할 인원을 선택하세요/);
assert.match(mobile, /이름을 눌러 일정을 확인하세요/);
for (const ui of [desktop, mobile]) {
  assert.doesNotMatch(ui, /과거 분석 보기/);
  assert.match(ui, /과거 분석 (?:결과|목록)/);
  assert.match(ui, /aiHistoryOpen: false/);
  assert.match(ui, /비교 인원 조건 설정/);
  assert.match(ui, /t:'2명 이하'/);
  assert.match(ui, /category === '마디영상'/);
  assert.match(ui, /aiCategoryTabs/);
  assert.match(ui, /openAiCategory/);
  assert.match(ui, /방송제 프로젝트/);
  assert.match(ui, /#ef5b6f/);
  assert.match(ui, /#14a6a1/);
}
assert.match(mobile, /aria-label="이전 주"/);
assert.match(mobile, /aria-label="다음 주"/);
assert.doesNotMatch(mobile, /personalViewOptions|목록 보기/);


/* 후보 계산이 같은 질문을 수천 번 되묻던 것들. 하나라도 풀리면 재배치가 다시 10초대로 돌아간다.
   (실측: 3화 16씬 기준 10,488ms → 18ms) */
assert.match(source, /const members = \(\) => \{ freshCache\(\); return revCache\.members \|\|= buildMembers\(\); \};/);
assert.doesNotMatch(source, /const members = \(\) => Object\.fromEntries/);
assert.match(source, /function shootsByDate\(iso\)/);
assert.match(source, /const value = computeRangesOn\(m, iso\);/);
assert.match(source, /shoots: shootsByDate\(iso\), memberIdsOfShoot: shootMemberIds,/);
assert.match(source, /if \(s\?\.category === '방송국'\) return new Set\(\);/);
assert.match(source, /if \(record\.category === '방송국'\) return \[\];/);

console.log('engine performance checks passed');
