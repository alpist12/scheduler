// PC 에만 있고 모바일에 없는 기능(또는 반대)을 찾는다. 눈으로 찾으면 계속 놓친다.
const fs = require('fs');

const read = f => {
  const src = fs.readFileSync(f, 'utf8');
  const script = src.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
  return { src, script };
};
const desk = read('standalone-desktop.html');
const mob = read('standalone-mobile.html');

// 1. 엔진 브리지 호출: 한쪽만 쓰는 기능
const calls = s => new Set([...s.matchAll(/\bengine(?:\(\))?\??\.([A-Za-z_$][\w$]*)\s*[?(]/g)].map(m => m[1]));
const dc = calls(desk.script), mc = calls(mob.script);
const onlyD = [...dc].filter(x => !mc.has(x));
const onlyM = [...mc].filter(x => !dc.has(x));
console.log('== 엔진 기능');
console.log('  PC 에만: ' + (onlyD.join(', ') || '없음'));
console.log('  모바일에만: ' + (onlyM.join(', ') || '없음'));

// 2. 같은 이름의 바인딩이 한쪽에만 있는 경우(핵심 화면 기준)
const keys = s => new Set([...s.matchAll(/^ {6}([A-Za-z_$][\w$]*):/gm)].map(m => m[1]));
const dk = keys(desk.script), mk = keys(mob.script);
const KEY = /^(plan|shoot|ai|member|personal|week|slot)/;
const missM = [...dk].filter(k => KEY.test(k) && !mk.has(k));
const missD = [...mk].filter(k => KEY.test(k) && !dk.has(k));
console.log('== 화면 바인딩 (plan/shoot/ai/member/personal/week/slot)');
console.log(`  PC ${[...dk].filter(k=>KEY.test(k)).length}개 · 모바일 ${[...mk].filter(k=>KEY.test(k)).length}개`);
console.log('  모바일에 없음: ' + (missM.join(', ') || '없음'));
console.log('  PC 에 없음: ' + (missD.join(', ') || '없음'));

// 3. 하드코딩된 날짜/숫자가 남아 있는지
for (const [name, o] of [['PC', desk], ['모바일', mob]]) {
  const hard = [...o.script.matchAll(/'(\d{4}-\d{2}-\d{2}|\d{1,2}월 \d{1,2}일[^']*)'/g)].map(m => m[1]);
  if (hard.length) console.log(`== ${name} 하드코딩 날짜: ${hard.join(', ')}`);
}
