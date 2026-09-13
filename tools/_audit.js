// 템플릿이 부르는 이름이 실제 바인딩에 있는지 본다. 없으면 그 버튼은 죽은 버튼이다.
const fs = require('fs');
for (const f of process.argv.slice(2)) {
  const src = fs.readFileSync(f, 'utf8');
  const m = src.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/);
  const script = m[1];
  const tpl = src.slice(0, src.indexOf('<script type="text/x-dc"'));

  // sc-for 가 만든 지역 이름(as="p")은 제외한다.
  const locals = new Set([...tpl.matchAll(/\bas="([\w$]+)"/g)].map(x => x[1]));
  const used = new Set();
  for (const x of tpl.matchAll(/\{\{\s*([\w$.]+)\s*\}\}/g)) {
    const head = x[1].split('.')[0];
    if (!locals.has(head) && !/^(true|false|null|\d)/.test(head)) used.add(head);
  }
  // 바인딩 객체에 있는 키 + 스프레드로 들어오는 것들
  const declared = new Set([...script.matchAll(/(^|[{,\s])([\w$]+)\s*:/gm)].map(x => x[2]));
  for (const x of script.matchAll(/\b([\w$]+),$/gm)) declared.add(x[1]);
  for (const x of script.matchAll(/\bconst\s+([\w$]+)\s*=/g)) declared.add(x[1]);
  const missing = [...used].filter(n => !declared.has(n));
  console.log(`${f}: 템플릿 참조 ${used.size}개 · 미정의 ${missing.length}개`);
  if (missing.length) console.log('  ' + missing.join(', '));
}
