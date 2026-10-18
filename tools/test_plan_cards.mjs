// 일차는 카드 순서가 아니라 날짜다. 카드는 날짜 순으로 세운 뒤에 번호를 매긴다.
import assert from 'node:assert';
import fs from 'node:fs';

// 화면 코드에서 정렬·번호 블록을 그대로 떼어 와 돌린다. 복붙한 사본을 시험하지 않기 위해서다.
const BLOCK = /out\.sort\(\(a, b\)[\s\S]*?\n {12}\}/;

for (const f of ['standalone-desktop.html', 'standalone-mobile.html']) {
  const src = fs.readFileSync(f, 'utf8');
  assert(!/nth \+= 1/.test(src), `${f}: 카드 순서로 일차를 매기는 코드가 남아 있다`);
  assert(/opts\.find\(o => !usedDates\.has/.test(src), `${f}: 전부 겹칠 때 첫 후보로 떨어지는 폴백이 남아 있다`);

  const m = src.match(BLOCK);
  assert(m, `${f}: 정렬·번호 블록 없음`);
  const run = new Function('out', `${m[0]}\nreturn out;`);

  const card = (dayKey, time, carryCard = false) =>
    ({ dayKey, carryCard, sortKey: dayKey ? `${dayKey}T${String(time).padStart(5, '0')}` : '' });

  // 묶음 순서대로 나온 카드 — 날짜가 뒤섞여 있다.
  const out = run([
    card('2026-09-29', 21),
    card('2026-09-25', 14),
    card('2026-09-29', 10),          // 같은 날 오전
    card('2026-09-27', 9, true),     // 이월 카드
    card('', 0),                     // 가능한 시간 없음
  ]);

  assert.deepEqual(out.map(x => x.dayKey),
    ['2026-09-25', '2026-09-27', '2026-09-29', '2026-09-29', ''], `${f}: 날짜 순 정렬 안 됨`);
  assert.deepEqual(out.map(x => x.nth),
    ['1일차', '2일차 (이월)', '3일차', '3일차', '4일차'], `${f}: 같은 날은 같은 일차여야 한다`);
}


// ── 시각 표기: 씬 분량이 30분 배수가 아니면 끝 시각이 22.25 처럼 나온다.
//    30분으로 반올림해 버리면 21:00–22:15 촬영이 21:00–22:30 으로 표시됐다.
for (const f of ['standalone-desktop.html', 'standalone-mobile.html']) {
  const src = fs.readFileSync(f, 'utf8');
  const m = src.match(/hourLabel\(h\) \{[\s\S]*?\n {2}\}/);
  assert(m, `${f}: hourLabel 없음`);
  const hourLabel = new Function(`return function ${m[0]}`)();

  const h24 = { setting: () => '24시간 (예: 14:00)' };
  assert.equal(hourLabel.call(h24, 21), '21:00');
  assert.equal(hourLabel.call(h24, 21.5), '21:30');
  assert.equal(hourLabel.call(h24, 22.25), '22:15', `${f}: 15분이 30분으로 반올림된다`);
  assert.equal(hourLabel.call(h24, 21 + 45 / 60), '21:45');
  assert.equal(hourLabel.call(h24, 9), '09:00');

  const h12 = { setting: () => '12시간 (예: 2:00 PM)' };
  assert.equal(hourLabel.call(h12, 14), '2 PM');
  assert.equal(hourLabel.call(h12, 14.25), '2:15 PM');

  // 저장은 정시 격자. 21.5 를 그대로 저장하면 목록이 '21.5:00' 으로 깨진다.
  assert(/const startH = Math\.floor\(slot\.time\);/.test(src), `${f}: startH 정규화 없음`);
  assert(/Math\.max\(startH \+ 1, Math\.ceil\(/.test(src), `${f}: endH 정규화 없음`);
  assert(!/startH: slot\.time/.test(src), `${f}: 소수 시각이 그대로 저장된다`);
  assert(!/\$\{slot\.time\}시/.test(src), `${f}: 확인창에 '21.5시' 가 찍힌다`);
}

// ── '전부 등록' 은 화면 카드를 그대로 써야 한다. 후보를 다시 고르면 보이는 것과 다른 일정이 등록된다.
{
  const src = fs.readFileSync('standalone-desktop.html', 'utf8');
  const body = src.slice(src.indexOf('registerAllDays = async'), src.indexOf('addGroupShoot = async'));
  assert(/this\.lastPlanDays/.test(body), '전부 등록이 화면 카드를 쓰지 않는다');
  assert(!/clashes\(/.test(body), '전부 등록이 후보를 다시 고르고 있다');
  assert(/this\.lastPlanDays = planDaysAll;/.test(src), '카드 결과를 남기지 않는다');
}
// ── 촬영 시각은 정시 격자. 21.5 가 저장되면 주간 달력의 `+s.startH === time` 에 안 걸려 사라진다.
{
  const src = fs.readFileSync('app.js', 'utf8');
  const m = src.match(/const gridHours = data => \{[\s\S]*?\n\};/);
  assert(m, 'app.js: gridHours 없음');
  const gridHours = new Function(`${m[0]}\nreturn gridHours;`)();

  assert.deepEqual(gridHours({ startH: 21, endH: 22 }), { startH: 21, endH: 22 });
  assert.deepEqual(gridHours({ startH: 21.5, endH: 22.25 }), { startH: 21, endH: 23 }, '소수 시각이 격자로 안 맞춰진다');
  assert.deepEqual(gridHours({ startH: 9.9, endH: 10 }), { startH: 9, endH: 10 });
  assert.deepEqual(gridHours({ startH: 14, endH: 14 }), { startH: 14, endH: 15 }, '끝이 시작보다 앞서면 안 된다');
  assert.deepEqual(gridHours({}), { startH: 0, endH: 1 });
  assert(/\.\.\.gridHours\(\{ startH: rawStart, endH: rawEnd \}\)/.test(src), '저장 경로가 격자를 안 쓴다');
}
console.log('plan cards OK');

// ── 부분 수정이 나머지 필드를 지우면 안 된다. (에어 '제목만 바꿔줘' → 출연·시간 증발)
{
  const src = fs.readFileSync('app.js', 'utf8');
  const save = src.slice(src.indexOf('async saveShoot(record = {})'), src.indexOf('async saveShoot(record = {})') + 1800);
  assert(/date: pick\('date'/.test(save), 'date 가 기존 값으로 안 떨어진다');
  assert(/title: pick\('title'/.test(save), 'title 이 기존 값으로 안 떨어진다');
  assert(/pick\('startH'/.test(save) && /pick\('endH'/.test(save), '시간이 기존 값으로 안 떨어진다');
  assert(!/startH: \+record\.startH/.test(save), 'record 값을 그대로 쓰고 있다');

  const html = fs.readFileSync('index.html', 'utf8');
  assert(!/saveShoot\(\{\.\.\.item,id:a\.id,projectId:project\?\.id\|\|null,cast\}\)/.test(html),
    '에어 수정이 출연진·프로젝트를 빈 값으로 덮어쓴다');
  assert(/Array\.isArray\(item\.castNames\)\?item\.castNames:null/.test(html), '안 넘어온 출연진을 구분하지 않는다');

  // 점검 상태를 못 읽으면 열어 주지 않는다.
  // 점검 상태를 못 읽었을 때 열어 주면 안 된다 (localhost 는 예외).
  const gate = html.slice(html.indexOf('MAINTENANCE_STATUS_URL'), html.indexOf('hnubsStartApp?.();') + 40);
  assert(gate.length > 100, '점검 게이트를 못 찾았다 — 구조가 바뀌었는지 확인할 것');
  assert(/showGate\(/.test(gate), '점검 상태 확인 실패 시 그냥 열어 준다 (fail-open)');
  assert(/localhost/.test(gate), 'localhost 예외가 없어 로컬 개발이 막힌다');
}
console.log('backend guards OK');

// ── 묶음끼리 충돌: 엔진이 이미 잡아 둔 자리를 알아야 한다.
//    예전에는 묶음마다 따로 계산해서 같은 사람이 같은 시간 네 묶음에 '전원 가능'으로 올라왔다.
{
  const src = fs.readFileSync('app.js', 'utf8');
  assert(/function aiCandidates\(scenes = \[\], durationHours = 0, busy = \[\], avoidDates = null\)/.test(src),
    'aiCandidates 가 이미 잡힌 자리를 안 받는다');
  assert(/const heldFor = \(member, iso, a, b\) => busy\.some/.test(src), '잡힌 자리를 빼는 검사가 없다');
  assert(/!heldFor\(member, iso, a, b\)\s*\n?\s*&& rangesOn/.test(src), 'freeIn 이 잡힌 자리를 무시한다');
  assert(/aiCandidates\(list\.map\(row => row\.scene\),.*, placed, fullDates\(\)\)/.test(src),
    '묶음 계산이 placed 를 안 넘긴다');
  assert(/if \(best\) placed\.push\(\{ date: best\.iso, start: best\.time, end: best\.endTime,/.test(src),
    '확정한 묶음의 자리를 기록하지 않는다');

  // heldFor 자체를 떼어 와 겹침 판정이 맞는지 본다
  const m = src.match(/const heldFor = \(member, iso, a, b\) => busy\.some\([\s\S]*?\);/);
  const heldFor = new Function('busy', `const f = ${m[0].replace('const heldFor = ', '')}\nreturn f;`)
    ([{ date: '2026-09-18', start: 15, end: 17, ids: new Set(['kim']) }]);
  const 김 = { __id: 'kim' }, 박 = { __id: 'park' };
  assert.equal(heldFor(김, '2026-09-18', 15, 16), true, '겹치는데 안 잡는다');
  assert.equal(heldFor(김, '2026-09-18', 16.5, 18), true, '끝자락 겹침을 놓친다');
  assert.equal(heldFor(김, '2026-09-18', 17, 18), false, '맞닿은 시간은 겹침이 아니다');
  assert.equal(heldFor(김, '2026-09-19', 15, 16), false, '다른 날까지 막는다');
  assert.equal(heldFor(박, '2026-09-18', 15, 16), false, '다른 사람까지 막는다');
}
console.log('engine busy-awareness OK');

// ── '나눠 찍기': 하루에 몰리지 않도록 분량을 나눈다.
//    (실측: 자동이면 9/18 에 4건 몰리던 것이 3일 기준에서 1/1/2/1 로 퍼진다)
{
  const src = fs.readFileSync('app.js', 'utf8');
  assert(/function aiCandidates\(scenes = \[\], durationHours = 0, busy = \[\], avoidDates = null\)/.test(src),
    'aiCandidates 가 피할 날짜를 안 받는다');
  assert(/avoidDates \? Number\(avoidDates\.has\(a\.iso\)\) - Number\(avoidDates\.has\(b\.iso\)\) : 0/.test(src),
    '찬 날짜를 뒤로 미는 정렬이 없다');
  assert(/const dayQuota = targetDays/.test(src), '하루 할당량 계산이 없다');
  assert(/targetDays: patch\.targetDays === undefined/.test(src), 'targetDays 가 저장되지 않는다');

  // 할당량 판정만 떼어 와 확인한다
  const m = src.match(/const fullDates = \(\) => \{[\s\S]*?\n  \};/);
  assert(m, 'fullDates 없음');
  const make = (placed, dayQuota) =>
    new Function('placed', 'dayQuota', `${m[0]}\nreturn fullDates();`)(placed, dayQuota);

  const placed = [
    { date: '2026-09-18', start: 13, end: 15 },   // 120분
    { date: '2026-09-18', start: 15, end: 16 },   //  60분 → 합 180
    { date: '2026-09-22', start: 19, end: 20 },   //  60분
  ];
  assert.deepEqual([...make(placed, 150)], ['2026-09-18'], '할당량을 넘긴 날을 못 걸러낸다');
  assert.equal(make(placed, 300), null, '아직 안 찬 날을 막는다');
  assert.equal(make(placed, Infinity), null, '자동(제한 없음)인데 날짜를 막는다');
}
console.log('spread days OK');

// ── AI가 UNKNOWN 장소를 내거나 낮/야외 씬을 늦은 밤으로 보내면 안 된다.
{
  const src = fs.readFileSync('app.js', 'utf8');
  assert(/const normalizedScenes = job =>/.test(src), 'UNKNOWN 장소 공통 정리가 없다');
  assert(/const scenes = normalizedScenes\(job\)/.test(src), '코파일럿이 UNKNOWN 장소 정리를 건너뛴다');
  assert(/const currentScenes = normalizedScenes\(currentAiJob\)/.test(src), '자동배치가 UNKNOWN 장소 정리를 건너뛴다');
  assert(/row\.scene\?\.dayNight/.test(src), 'AI 분석의 낮\/밤 값을 자동배치가 쓰지 않는다');
  assert(/period === 'day' \|\| outdoor/.test(src) && /slot\.time \+ result\.totalHours <= 20/.test(src),
    '낮\/야외 씬의 20시 종료 제한이 없다');
}
console.log('scene period guards OK');

// 모바일 조건 패널 안에서 조건을 확정할 수 있어야 한다. 일차 카드마다 버튼을 복제하지 않는다.
{
  const mobile = fs.readFileSync('standalone-mobile.html', 'utf8');
  const conditionPanel = mobile.match(/<!-- 분석 조건[\s\S]*?<!-- AI 자동 배치/)?.[0] || '';
  const planCard = mobile.match(/<sc-for list="\{\{ planDays \}\}"[\s\S]*?<sc-for list="\{\{ p\.sections \}\}"/)?.[0] || '';
  assert(/applyPlanConditions/.test(conditionPanel), '모바일 조건 패널에 재배치 버튼이 없다');
  assert(!/applyPlanConditions/.test(planCard), '재배치 버튼이 모바일 일차 카드 안에 잘못 들어갔다');
}
console.log('mobile condition actions OK');
