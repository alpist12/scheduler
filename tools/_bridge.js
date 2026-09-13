// 화면이 engine.무엇() 을 부르는데 app.js 브리지에 그게 없으면 그 버튼은 눌러도 죽는다.
const fs = require('fs');

const app = fs.readFileSync('app.js', 'utf8');
// 브리지 객체(window.HNUBS_ENGINE) 에 실린 이름들
const bridge = new Set();
const start = app.indexOf('HNUBS_ENGINE');
const tail = app.slice(start);
for (const m of tail.matchAll(/^\s{2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*[(:]/gm)) bridge.add(m[1]);

let bad = 0;
for (const f of ['standalone-desktop.html', 'standalone-mobile.html', 'index.html']) {
  const src = fs.readFileSync(f, 'utf8');
  const called = new Set();
  for (const m of src.matchAll(/\bengine(?:\(\))?\??\.([A-Za-z_$][\w$]*)\s*[?(]/g)) called.add(m[1]);
  for (const m of src.matchAll(/HNUBS_ENGINE\??\.([A-Za-z_$][\w$]*)\s*[?(]/g)) called.add(m[1]);
  const missing = [...called].filter(n => !bridge.has(n));
  console.log(`${f}: engine.* 호출 ${called.size}개 · 브리지에 없음 ${missing.length}개`);
  if (missing.length) { console.log('  ' + missing.join(', ')); bad += missing.length; }
}
console.log(`브리지가 내보내는 메서드 ${bridge.size}개`);
process.exitCode = bad ? 1 : 0;
