// sc-if / sc-for 짝이 안 맞으면 화면 한 덩어리가 통째로 사라진다.
// 세부 조건이 안 열리던 버그가 이것이었다. 눈으로는 못 찾는다.
const fs = require('fs');
let bad = 0;
for (const f of process.argv.slice(2)) {
  const src = fs.readFileSync(f, 'utf8');
  const tpl = src.slice(0, src.indexOf('<script type="text/x-dc"'));
  for (const tag of ['sc-if', 'sc-for']) {
    const open = (tpl.match(new RegExp(`<${tag}\\b`, 'g')) || []).length;
    const close = (tpl.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    if (open !== close) {
      bad += 1;
      // 어디서 안 닫혔는지 문자 순서대로 추적한다
      const toks = [...tpl.matchAll(new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, 'g'))];
      const stack = [];
      for (const t of toks) {
        const line = tpl.slice(0, t.index).split('\n').length;
        if (t[0].startsWith('</')) stack.pop();
        else stack.push({ line, val: (t[0].match(/value="\{\{ ([^}]+) \}\}"/) || [])[1] || '' });
      }
      console.log(`${f}: ${tag} 열림 ${open} / 닫힘 ${close}`);
      stack.forEach(x => console.log(`  안 닫힘 → ${x.line}행 ${x.val}`));
    }
  }
}
console.log(bad ? `짝 안 맞는 태그 ${bad}건` : '태그 짝 OK');
process.exitCode = bad ? 1 : 0;
