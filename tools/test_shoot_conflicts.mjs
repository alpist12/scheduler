/* 겹침 판정 규칙만 따로 검증한다. app.js 는 브라우저 전용이라
   같은 규칙을 여기 옮겨 두고, 규칙이 바뀌면 양쪽을 같이 고친다.
   ponytail: 규칙 복제, app.js 를 모듈로 쪼개면 import 로 바꾼다. */
import assert from 'node:assert';

const NAMES = { a: '최원재', b: '이서연', c: '강주형' };
const shoots = {
  s1: { date: '2026-09-13', startH: 14, endH: 16, title: '3화 S#2', castIds: ['a', 'b'] },
  s2: { date: '2026-09-14', startH: 14, endH: 16, title: '다른 날', castIds: ['a'] },
};

function shootConflicts({ id = '', date, startH, endH, castIds = [] }) {
  const wanted = new Set(castIds);
  if (!wanted.size) return [];
  return Object.entries(shoots).flatMap(([key, s]) => {
    if (key === id || s.date !== date) return [];
    if (!(startH < s.endH && endH > s.startH)) return [];
    const people = s.castIds.filter(x => wanted.has(x)).map(x => NAMES[x]);
    return people.length ? [{ shootId: key, title: s.title, people }] : [];
  });
}

const at13 = extra => ({ date: '2026-09-13', startH: 15, endH: 17, ...extra });

// 시간은 겹치는데 배우가 다르다 → 같이 찍을 수 있다
assert.deepStrictEqual(shootConflicts(at13({ castIds: ['c'] })), []);
// 같은 배우가 같은 시간 → 충돌, 누군지 알려준다
assert.deepStrictEqual(shootConflicts(at13({ castIds: ['b', 'c'] })).map(x => x.people), [['이서연']]);
// 시간이 안 겹치면 같은 배우라도 통과
assert.deepStrictEqual(shootConflicts({ date: '2026-09-13', startH: 16, endH: 18, castIds: ['a'] }), []);
// 날짜가 다르면 통과
assert.deepStrictEqual(shootConflicts(at13({ date: '2026-09-15', castIds: ['a'] })), []);
// 자기 자신을 수정할 때 스스로와 충돌하지 않는다
assert.deepStrictEqual(shootConflicts({ id: 's1', date: '2026-09-13', startH: 14, endH: 16, castIds: ['a'] }), []);
// 출연자가 없으면 물어볼 것도 없다
assert.deepStrictEqual(shootConflicts(at13({ castIds: [] })), []);

console.log('shoot conflict rules OK');
