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
// ── 인원 칩은 부서마다 한 줄. 줄바꿈하면 목록이 세로로 길어져 일정표를 밀어낸다.
{
  const mob = fs.readFileSync('standalone-mobile.html', 'utf8');
  const row = mob.match(/<div data-chiprow style="([^"]+)"/);
  assert(row, '인원 칩 줄을 못 찾았다');
  assert(/flex-wrap:nowrap/.test(row[1]), '칩이 여러 줄로 쌓인다');
  assert(/overflow-x:auto/.test(row[1]), '넘치는 인원을 볼 방법이 없다');

  // 칩이 찌그러지지 않아야 이름이 다 보인다
  const btn = mob.slice(row.index, row.index + 700).match(/<button[^>]*style="([^"]+)"/);
  assert(btn && /flex:0 0 auto/.test(btn[1]), '칩이 줄어들어 이름이 찌그러진다');

  // 촬영 폼의 출연진 선택은 다중 선택이라 여러 줄이 맞다 — 같이 바꾸지 않았는지
  assert(/<div style="display:flex;flex-wrap:wrap;gap:7px">/.test(mob),
    '출연진 다중 선택까지 한 줄로 바꿨다');
}
console.log('air handle OK');
