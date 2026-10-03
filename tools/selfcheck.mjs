/* 에어/분석이 조용히 깨지는 자리를 잡아 둔다. node tools/selfcheck.mjs */
import assert from 'node:assert';
import { pathParts, sceneHeadings, splitScenes, countHeadings } from '../netlify/functions/_shared.mjs';
import { fastLocalResult } from '../netlify/functions/chat.mjs';

// 1. 리다이렉트를 거친 실제 요청 모양. 예전에 여기서 '작업 ID가 없습니다' 가 났다.
assert.deepStrictEqual(
  pathParts({ rawUrl: 'https://hnubs.netlify.app/api/chat/jobs/abc123' }, 'chat-job'), ['abc123']);
assert.deepStrictEqual(
  pathParts({ rawUrl: 'https://hnubs.netlify.app/.netlify/functions/chat-job/abc123' }, 'chat-job'), ['abc123']);
assert.deepStrictEqual(
  pathParts({ rawUrl: 'https://hnubs.netlify.app/api/analysis/jobs/j1' }, 'analysis-job'), ['j1']);
assert.deepStrictEqual(pathParts({ rawUrl: 'https://hnubs.netlify.app/api/chat' }, 'chat-job'), []);

// 2. 씬 개수는 제목 줄로 센다. 분할 조각 수로 세면 표지까지 한 씬이 된다.
const script = ['표지 없음', 'S#1 교실', '대사', 'S#2 복도', '대사', 'S#3 운동장'].join('\n');
assert.strictEqual(countHeadings(script), 3);
assert.strictEqual(sceneHeadings(script).length, 3);
assert.ok(splitScenes(script).length >= 1);

console.log('selfcheck OK');

// 3. 준비한 건수와 나열한 건수가 어긋나면 안 된다. 9건이면 9줄이 보여야 한다.
{
  const src = await import('node:fs').then(fs => fs.readFileSync('netlify/functions/chat.mjs', 'utf8'));
  const body = src.match(/function bulletList[\s\S]*?\n}/)[0];
  const bulletList = new Function(`${body}; return bulletList;`)();
  const nine = Array.from({ length: 9 }, (_, i) => i + 1);
  assert.strictEqual(bulletList(nine, n => `· ${n}`).split('\n').length, 9);
  const many = Array.from({ length: 25 }, (_, i) => i + 1);
  const cut = bulletList(many, n => `· ${n}`).split('\n');
  assert.strictEqual(cut.length, 21);
  assert.strictEqual(cut.at(-1), '· 외 5건');
}

console.log('bullet list OK');

// 4. 이름 + 날짜별 가능 목록은 등록된 회의·수업 시간을 읽어 한 번에 준비한다.
{
  const input = `강주형
10/5 가능
10/6 4시 이후 6시 이전
10/7 불가
10/8 불가

10/12 회의 이후
10/13 ~15 수업 제외
10/16 불가`;
  const result = fastLocalResult(input, {
    currentDate: '2026-10-04',
    members: [{ name: '강주형', fixedSchedule: {
      mon: [{ start: 18, end: 19, label: '회의' }],
      tue: [{ start: 10, end: 12, label: '열역학' }],
      wed: [{ start: 14, end: 17, label: '재료과학' }],
      thu: [{ start: 9, end: 11, label: '기초실험' }],
    } }],
  });
  assert.strictEqual(result.route, 'local-personal-bulk');
  assert.strictEqual(result.action.type, 'personal_schedules');
  assert.strictEqual(result.action.items.length, 12);
  assert.deepStrictEqual(result.action.items.filter(x => x.date === '2026-10-12').map(x => [x.status, x.start, x.end]),
    [['불가능', 9, 19], ['가능', 19, 23]]);
  assert.deepStrictEqual(result.action.items.filter(x => x.date === '2026-10-13').map(x => [x.status, x.start, x.end]),
    [['불가능', 10, 12]]);
  const noMeeting = fastLocalResult(input, {
    currentDate: '2026-10-04',
    members: [{ name: '강주형', fixedSchedule: {
      tue: [{ start: 10, end: 12, label: '열역학' }],
      wed: [{ start: 14, end: 17, label: '재료과학' }],
      thu: [{ start: 9, end: 11, label: '기초실험' }],
    } }],
  });
  assert.strictEqual(noMeeting.route, 'local-personal-bulk-needs');
  assert.match(noMeeting.reply, /회의 종료 시각만 알려 주세요/);
  assert.doesNotMatch(noMeeting.reply, /수업.*알려/);
}

console.log('bulk personal schedule OK');
