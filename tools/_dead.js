// 정의만 있고 아무도 안 쓰는 것들. 죽은 버튼/죽은 코드를 찾는다.
const fs = require('fs');

function dcParts(file) {
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/);
  return { src, script: m[1], tpl: src.slice(0, src.indexOf('<script type="text/x-dc"')) };
}

for (const f of ['standalone-desktop.html', 'standalone-mobile.html']) {
  const { script, tpl } = dcParts(f);
  // 템플릿이 쓰는 이름 (지역 변수 포함해 전부)
  const used = new Set();
  for (const x of tpl.matchAll(/\{\{\s*([\w$.]+)\s*\}\}/g)) {
    used.add(x[1]);                       // p.confirm 같은 전체 경로
    used.add(x[1].split('.').pop());      // 마지막 조각
    used.add(x[1].split('.')[0]);
  }
  // 바인딩 객체 최상위 키 (들여쓰기 6칸)
  const declared = [...script.matchAll(/^ {6}([A-Za-z_$][\w$]*):/gm)].map(x => x[1]);
  const unused = [...new Set(declared)].filter(n => {
    if (used.has(n)) return false;
    // 스크립트 안에서 다시 쓰이면 살아 있는 것으로 본다
    const hits = script.split(new RegExp(`\\b${n}\\b`)).length - 1;
    return hits <= 1;
  });
  console.log(`${f}: 바인딩 ${new Set(declared).size}개 · 아무도 안 씀 ${unused.length}개`);
  if (unused.length) console.log('  ' + unused.join(', '));

  // 클래스 메서드 중 호출되지 않는 것
  const methods = [...script.matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?[(\w]/gm)].map(x => x[1]);
  const deadM = [...new Set(methods)].filter(n => {
    const hits = script.split(new RegExp(`\\bthis\\.${n}\\b`)).length - 1;
    return hits === 0 && !used.has(n);
  });
  if (deadM.length) console.log(`  메서드인데 호출 없음: ${deadM.join(', ')}`);
}
