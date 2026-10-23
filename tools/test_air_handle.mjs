// 에어 손잡이와 대화창. 애니메이션이 사라지면 '툭 나타나는' 옛 모습으로 돌아간다.
import assert from 'node:assert';
import fs from 'node:fs';

const html = fs.readFileSync('index.html', 'utf8');
const css = html.slice(0, html.indexOf('</style>', html.indexOf('.ai-pal{')));

// ── 대화창: display 토글이 아니라 미끄러져 들어온다
assert(!/\.ai-pal-chat\{[^}]*display:none/.test(css), '대화창이 display:none 으로 숨는다 — 전환이 안 먹는다');
assert(/\.ai-pal-chat\{[^}]*visibility:hidden/.test(css), '닫힌 대화창이 화면에서 빠지지 않는다');
assert(/\.ai-pal-chat\{[^}]*transition:[^}]*transform/.test(css), '대화창에 전환이 없다');
// 시작/끝이 같은 형태여야 보간된다 (transform:none 이면 안 미끄러진다)
assert(/\.ai-pal-chat\.open\{[^}]*transform:translateX\(0\) scale\(1\)/.test(css),
  '열린 상태의 transform 이 보간 가능한 값이 아니다');

// ── 손잡이: 가장자리에 걸쳐 있다가 나온다
assert(/\.ai-pal-button\{[^}]*transform:translateX\(\d+px\)/.test(css), '손잡이가 가장자리에 숨지 않는다');
assert(/\.ai-pal:hover \.ai-pal-button,\.ai-pal-button:focus-visible\{[^}]*transform:translateX\(0\)/.test(css),
  '다가가거나 키보드로 짚어도 손잡이가 안 나온다');
assert(/border-radius:24px 0 0 24px/.test(css), '손잡이가 한쪽만 둥근 모양이 아니다');
assert(/\.ai-pal-chat\.open ~ \.ai-pal-button\{[^}]*pointer-events:none/.test(css),
  '대화창이 열려도 손잡이가 남아 가린다');

// ── 움직임을 줄여 달라는 설정 존중
assert(/prefers-reduced-motion/.test(css), '움직임 축소 설정을 무시한다');

// ── 화면마다 스크롤이 생겼다 사라져도 하단 탭 간격이 흔들리지 않는다
for (const f of ['standalone-mobile.html', 'standalone-desktop.html']) {
  assert(/scrollbar-gutter:stable/.test(fs.readFileSync(f, 'utf8')),
    `${f}: 스크롤바 자리를 비워 두지 않는다 — 탭을 옮길 때 하단바 간격이 변한다`);
}

// ── 빌드 결과에도 반영됐는지
const built = fs.readFileSync('dist/client/index.html', 'utf8');
assert(/border-radius:24px 0 0 24px/.test(built), '빌드 결과에 손잡이 스타일이 없다');
// ── 떠 있는 + 버튼은 화면을 옮길 때마다 떠오르며 나타난다
{
  const mob = fs.readFileSync('standalone-mobile.html', 'utf8');
  assert(/@keyframes fabIn\{from\{opacity:0/.test(mob), 'fabIn 키프레임이 없다');
  assert(/animation:fabIn [\d.]+s/.test(mob), '+ 버튼에 애니메이션이 안 붙었다');
  assert(/@media\(prefers-reduced-motion:reduce\)\{@keyframes fabIn/.test(mob),
    '움직임 축소 설정에서도 튀어오른다');
  assert(/animation:fabIn[^"]*both/.test(mob),
    'both 가 없으면 시작 전 한 프레임이 제자리에 보인다');
  assert(fs.readFileSync('dist/client/standalone-mobile.html', 'utf8').includes('fabIn'),
    '빌드 결과에 반영되지 않았다');
}
console.log('air handle OK');
