// this.foo() 로 부르는데 정의가 없는 메서드를 찾는다. 모바일 addGroupShoot 이 그렇게 죽어 있었다.
const fs = require('fs');
for (const f of process.argv.slice(2)) {
  const src = fs.readFileSync(f, 'utf8');
  const script = src.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
  const called = new Set([...script.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*\(/g)].map(x => x[1]));
  const defined = new Set([
    ...[...script.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*=\s*(async\s+)?(\(|[A-Za-z_$][\w$]*\s*=>)/gm)].map(x => x[1]),
    ...[...script.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)].map(x => x[1]),
  ]);
  // React 계열 기본 제공
  for (const n of ['setState', 'forceUpdate', 'render']) defined.add(n);
  const missing = [...called].filter(n => !defined.has(n));
  console.log(`${f}: this.* 호출 ${called.size}개 · 미정의 ${missing.length}개`);
  if (missing.length) console.log('  ' + missing.join(', '));
}
