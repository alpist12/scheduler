/* 에어/분석이 조용히 깨지는 자리를 잡아 둔다. node tools/selfcheck.mjs */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { pathParts, sceneHeadings, splitScenes, countHeadings } from '../api/_shared.mjs';
import { fastLocalResult } from '../api/chat.mjs';

// 공개 클라이언트가 Firestore를 직접 쓰는 동안 규칙 만료를 배포 전에 잡는다.
const rules = readFileSync('firestore.rules', 'utf8');
const expiry = rules.match(/timestamp\.date\((\d{4}),\s*(\d{1,2}),\s*(\d{1,2})\)/);
assert.ok(expiry, 'Firestore 규칙 만료일이 없습니다.');
const expiresAt = Date.UTC(+expiry[1], +expiry[2] - 1, +expiry[3]);
assert.ok(expiresAt - Date.now() > 90 * 24 * 60 * 60 * 1000, 'Firestore 규칙 만료가 90일 이내입니다.');

// 1. 리다이렉트를 거친 실제 요청 모양. 예전에 여기서 '작업 ID가 없습니다' 가 났다.
assert.deepStrictEqual(
  pathParts({ rawUrl: 'https://hnubs.netlify.app/api/chat/jobs/abc123' }, 'chat-job'), ['abc123']);
assert.deepStrictEqual(
  pathParts({ rawUrl: 'https://hnubs.netlify.app/.api/chat-job/abc123' }, 'chat-job'), ['abc123']);
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
  const src = await import('node:fs').then(fs => fs.readFileSync('api/chat.mjs', 'utf8'));
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

// 5. 여러 사람의 일정 묶음도 서로 섞지 않고 하나의 확인 액션으로 준비한다.
{
  const result = fastLocalResult(`강주형
10/19 가능
10/20 4시 이후 6시 이전

김기주
10/19 불가능
10/20 수업 제외`, {
    currentDate: '2026-10-17',
    members: [
      { name: '강주형', fixedSchedule: {} },
      { name: '김기주', fixedSchedule: { tue: [{ start: 10, end: 12, label: '수업' }] } },
    ],
  });
  assert.strictEqual(result.route, 'local-personal-bulk');
  assert.strictEqual(result.action.type, 'personal_schedules');
  assert.deepStrictEqual([...new Set(result.action.items.map(x => x.memberName))], ['강주형', '김기주']);
  assert.deepStrictEqual(result.action.items.filter(x => x.memberName === '강주형' && x.date === '2026-10-19')
    .map(x => [x.status, x.start, x.end]), [['가능', 9, 23]]);
  assert.deepStrictEqual(result.action.items.filter(x => x.memberName === '김기주' && x.date === '2026-10-20')
    .map(x => [x.status, x.start, x.end]), [['불가능', 10, 12]]);
}

console.log('multi-member personal schedule OK');
