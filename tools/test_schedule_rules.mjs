/* 코파일럿 판정이 이 규칙들 위에 서 있다. 여기가 깨지면 씬 분류가 조용히 틀어진다. */
import assert from 'node:assert';
import { candidateStarts, continuityScore, locationAffinity, sceneMinutes, hourText } from '../schedule-rules.mjs';

// 예상시간이 없거나 0이면 30분으로 본다. 0분짜리 씬은 아무 데나 들어가 버린다.
assert.strictEqual(sceneMinutes({}), 30);
assert.strictEqual(sceneMinutes({ estimatedMinutes: 0 }), 30);
assert.strictEqual(sceneMinutes({ estimatedMinutes: 45 }), 45);

assert.strictEqual(hourText(18.5), '18:30');
assert.strictEqual(hourText(9), '09:00');

/* 같은 건물이면 낱말이 겹친다. 정확히 같은 글자만 보면 N5동 복도와 N5동 강의실을
   남남으로 처리해 연속 촬영 추천이 통째로 죽는다. */
assert.ok(locationAffinity({ location: 'N5동 복도' }, { location: 'N5동 강의실' }) > 0);
assert.strictEqual(locationAffinity({ location: 'N5동 복도' }, { location: '공대건물 분수대' }), 0);
// '복도'·'교실' 같은 흔한 낱말만 겹치는 건 같은 장소로 치지 않는다
assert.strictEqual(locationAffinity({ location: 'N5동 복도' }, { location: 'S2동 복도' }), 0);

/* 30분 눈금 + 실제 가능 경계. 18:35부터 가능한 사람이 있으면 18:35도 후보여야 한다.
   눈금만 쓰면 19:00으로 밀려 35분을 통째로 버린다. */
const starts = candidateStarts({
  totalHours: 1,
  windows: [{ from: 0, to: 1, ranges: [{ start: 18 + 35 / 60, end: 22 }] }],
});
assert.ok(starts.includes(18.5), '30분 눈금이 있어야 한다');
assert.ok(starts.some(v => Math.abs(v - (18 + 35 / 60)) < 1e-9), '실제 경계 18:35 가 후보에 있어야 한다');
// 하루 끝을 넘는 시작은 나오면 안 된다
assert.ok(starts.every(v => v + 1 <= 23));

/* 연속 촬영: 앞 촬영이 끝나자마자 같은 인원이면 점수가 가장 높다. */
const shoots = [
  { date: '2026-09-17', startH: 18, endH: 19, title: '1화 S#1', cast: [{ id: 'a' }] },
  { date: '2026-09-17', startH: 9, endH: 10, title: '먼 촬영', cast: [{ id: 'a' }] },
];
const ids = s => new Set((s.cast || []).map(x => x.id));
const touching = continuityScore({ date: '2026-09-17', start: 19, end: 20, requiredIds: ['a'], shoots, memberIdsOfShoot: ids });
assert.ok(touching.score > 0 && /연속 촬영/.test(touching.label), touching.label);
// 사람이 안 겹치면 연속으로 보지 않는다
assert.strictEqual(continuityScore({ date: '2026-09-17', start: 19, end: 20, requiredIds: ['b'], shoots, memberIdsOfShoot: ids }).score, 0);
// 9시간 떨어진 촬영은 연속이 아니다
assert.strictEqual(continuityScore({ date: '2026-09-17', start: 19, end: 20, requiredIds: ['a'], shoots: [shoots[1]], memberIdsOfShoot: ids }).score, 0);

/* 촬영 가능 시간대를 넘기면 그 밖은 후보가 되면 안 된다.
   안 넘겨서 기본값 9~23 이 쓰이는 바람에 저녁 촬영에 아침 9시가 올라온 적이 있다. */
const evening = candidateStarts({
  totalHours: 1,
  windows: [{ from: 0, to: 1, ranges: [{ start: 9, end: 23 }] }],
  dayStart: 18, dayEnd: 22.5,
});
assert.ok(evening.length, '후보가 하나는 나와야 한다');
assert.ok(evening.every(v => v >= 18 && v + 1 <= 22.5), JSON.stringify(evening));
assert.ok(!evening.includes(9) && !evening.includes(13));

console.log('schedule rules OK');
