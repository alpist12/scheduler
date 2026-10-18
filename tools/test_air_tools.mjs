/* 에어 도구는 화면이 준 데이터만 읽어야 한다. 지어내면 그게 곧 사고다. */
import assert from 'node:assert';
import { runTool, TOOLS } from '../api/_tools.mjs';

const hours = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
const dateIsos = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'];
// 목요일(index 3) 18~20시만 세 명 모두 가능
const availableNames = dateIsos.map((_, d) => hours.map(h =>
  (d === 3 && (h === 18 || h === 19)) ? ['강주형', '이서연', '신유진'] : (h === 14 ? ['강주형'] : [])));

const context = {
  currentDate: '2026-09-13', hours, dateIsos, availableNames,
  members: [{ name: '강주형', dept: '아나운서부', hours: 10 }, { name: '고재헌', dept: '기술부', hours: 4 }],
  projects: [
    { id: 'p1', name: '1화', aiAnalysis: { scenes: [
      { sceneId: 'S#1', estimatedMinutes: 45 },
      { sceneId: 'S#2', estimatedMinutes: 70 },
      { sceneId: 'S#3', estimatedMinutes: 20 },
    ] } },
    { id: 'p5', name: '5화' },
  ],
  shoots: [
    { id: 'a1', date: '2026-09-14', startH: 18, endH: 19, title: '1화 S#1', cast: [{ name: '강주형' }] },
    { id: 'a2', date: '2026-09-17', startH: 18, endH: 23, title: '1화 S#3', cast: [{ name: '이서연' }] },
  ],
};

// 날짜는 서버가 계산한다. 모델이 연도를 지어내면 안 된다.
const d = runTool('resolve_dates', { expression: '다음 주' }, context);
assert.strictEqual(d.오늘, '2026-09-13');
assert.strictEqual(d.다음주.시작, '2026-09-14');
assert.strictEqual(d.다음주.끝, '2026-09-20');

// 공통 가능 시간은 격자에서만 나온다
const free = runTool('find_free_time', { names: ['강주형', '이서연'] }, context);
assert.strictEqual(free.공통가능.length, 1);
assert.ok(free.공통가능[0].includes('18:00~20:00'), free.공통가능[0]);

// 없는 사람은 조용히 무시하지 않고 알려 준다
const ghost = runTool('find_free_time', { names: ['강주형', '없는사람'] }, context);
assert.deepStrictEqual(ghost.이름을_못찾음, ['없는사람']);
assert.strictEqual(ghost.공통가능.length, 0);

// 기간·사람으로 거른다
assert.strictEqual(runTool('list_shoots', { from: '2026-09-17', to: '2026-09-17' }, context).건수, 1);
assert.strictEqual(runTool('list_shoots', { person: '강주형' }, context).건수, 1);
assert.strictEqual(runTool('list_shoots', {}, context).목록[0].id, 'a1');
// 요일은 서버가 적는다. 모델이 세면 9/14(월)를 '화'로 적는 일이 생긴다.
assert.strictEqual(runTool('list_shoots', {}, context).목록[0].날짜, '2026-09-14 (월)');
assert.ok(runTool('who_is_free', { date: '2026-09-17', hour: 18 }, context).날짜.endsWith('(목)'));

// 부서로 거른다
assert.strictEqual(runTool('list_members', { department: '기술' }, context).인원수, 1);

// 저장 도구는 '액션'만 만든다. 서버가 직접 저장하지 않는다.
const made = runTool('create_shoots', { items: [{ title: '5화 S#7', date: '2026-09-17', startH: 18, endH: 19 }] }, context);
assert.ok(made.__action && made.__action.type === 'shoot_schedules');

// id 없이 삭제를 시키면 거절하고 되묻게 한다
assert.ok(runTool('delete_shoot', {}, context).error);
assert.ok(runTool('없는도구', {}, context).error);

// 스키마가 깨지면 모델이 도구를 못 부른다
for (const t of TOOLS) {
  assert.strictEqual(t.type, 'function');
  assert.ok(t.function.name && t.function.description);
  assert.strictEqual(t.function.parameters.type, 'object');
}

// ── 새로 붙인 도구들 ──────────────────────────────────────
const withSchedule = {
  ...context,
  members: [
    { name: '강주형', dept: '아나운서부', hours: 10,
      fixedSchedule: { mon: [{ start: 9, end: 12, label: '전공수업' }] },
      schedules: { '2026-09-15': { status: '불가능', ranges: [{ start: 18, end: 23 }] } } },
    { name: '고재헌', dept: '기술부', hours: 4 },
  ],
};
const sched = runTool('get_member_schedule', { name: '강주형' }, withSchedule);
assert.strictEqual(sched.매주_반복[0].내용, '전공수업');
assert.strictEqual(sched.매주_반복[0].시간, '09:00~12:00');
assert.strictEqual(sched.개인일정[0].상태, '불가능');
assert.strictEqual(sched.촬영.length, 1);           // a1 에 출연
// 없는 사람은 등록 인원을 알려 주고 지어내지 않는다
assert.ok(runTool('get_member_schedule', { name: '없는사람' }, withSchedule).error);

// 시간이 겹쳐도 사람이 다르면 충돌이 아니다
assert.strictEqual(runTool('find_conflicts', {}, context).충돌, 0);
const clashCtx = { ...context, shoots: [
  { id: 'x', date: '2026-09-14', startH: 18, endH: 20, title: 'A', cast: [{ name: '강주형' }] },
  { id: 'y', date: '2026-09-14', startH: 19, endH: 21, title: 'B', cast: [{ name: '강주형' }] },
  { id: 'z', date: '2026-09-14', startH: 19, endH: 21, title: 'C', cast: [{ name: '이서연' }] },
] };
const conf = runTool('find_conflicts', {}, clashCtx);
assert.strictEqual(conf.충돌, 1);
assert.deepStrictEqual(conf.목록[0].겹치는인원, ['강주형']);

// 통계
const sum = runTool('summarize_shoots', {}, context);
assert.strictEqual(sum.건수, 2);
assert.strictEqual(sum.총시간, '6시간');            // 1시간 + 5시간

// 특정 시각에 되는 사람
const freeAt = runTool('who_is_free', { date: '2026-09-17', hour: 18 }, context);
assert.deepStrictEqual(freeAt.가능, ['강주형', '이서연', '신유진']);
assert.ok(runTool('who_is_free', { date: '2026-10-01', hour: 18 }, context).error);

// 출연진만 바꾸기 — 나머지 값은 그대로 유지돼야 한다
const edited = runTool('edit_shoot_cast', { id: 'a1', add: ['이서연'], remove: ['강주형'] }, context);
assert.strictEqual(edited.__action.type, 'shoot_update');
assert.deepStrictEqual(edited.__action.item.castNames, ['이서연']);
assert.strictEqual(edited.__action.item.date, '2026-09-14');
assert.ok(runTool('edit_shoot_cast', { id: '없는id' }, context).error);

// 같은 날 몰아 찍기: 사람이 겹치면 뒤로 밀고, 안 겹치면 같은 시간에 둔다
{
  const same = runTool('create_shoots', { items: [
    { title: 'A', date: '2026-09-15', startH: 18, endH: 22, castNames: ['강주형','이서연'] },
    { title: 'B', date: '2026-09-15', startH: 18, endH: 22, castNames: ['이서연'] },
  ] }, context).__action.items;
  assert.strictEqual(same[0].startH, 18);
  assert.ok(same[1].startH >= same[0].endH, '사람이 겹치면 뒤로 밀려야 한다');

  const apart = runTool('create_shoots', { items: [
    { title: 'A', date: '2026-09-15', startH: 18, endH: 22, castNames: ['강주형'] },
    { title: 'B', date: '2026-09-15', startH: 18, endH: 22, castNames: ['신유진'] },
  ] }, context).__action.items;
  assert.strictEqual(apart[0].startH, 18);
  assert.strictEqual(apart[1].startH, 18, '사람이 안 겹치면 같은 시간이어야 한다');

  // 끝 시각 없이 '이후'만 주면 AI 분석의 씬별 예상시간을 우선 쓴다
  const open = runTool('create_shoots', { items: [{ title: 'C', date: '2026-09-15', startH: 18.5 }] }, context).__action.items[0];
  assert.strictEqual(open.endH, 19);
  assert.ok(/기본 예상시간 30분/.test(open.note));

  const analyzed = runTool('create_shoots', { items: [{ title: '1화 S#1', projectName: '1화', date: '2026-09-15', startH: 18 }] }, context).__action.items[0];
  assert.strictEqual(analyzed.endH, 18.75);
  assert.ok(/AI 분석 예상시간 45분/.test(analyzed.note));

  const afterScenes = runTool('create_shoots', { items: [
    { title: 'S#1', projectName: '1화', date: '2026-09-15', startH: 18, castNames: ['이서연'] },
    { title: 'S#2', projectName: '1화', date: '2026-09-15', startH: 18, castNames: ['이서연'] },
    { title: 'S#3', projectName: '1화', date: '2026-09-15', startH: 18, castNames: ['이서연'] },
  ] }, context).__action.items;
  assert.deepStrictEqual(afterScenes.map(x => [x.startH, x.endH]), [[18, 18.75], [18.75, 18.75 + 70 / 60], [18.75 + 70 / 60, 18.75 + 70 / 60 + 20 / 60]]);
}

console.log('air tools OK');
