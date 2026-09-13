/* 에어/분석이 조용히 깨지는 자리를 잡아 둔다. node tools/selfcheck.mjs */
import assert from 'node:assert';
import { pathParts, sceneHeadings, splitScenes, countHeadings } from '../netlify/functions/_shared.mjs';

// 1. 리다이렉트를 거친 실제 요청 모양. 예전에 여기서 '작업 ID가 없습니다' 가 났다.
assert.deepStrictEqual(
  pathParts({ rawUrl: 'https://hnubs.netlify.app/api/chat/jobs/abc123' }, 'chat-job'), ['abc123']);
assert.deepStrictEqual(
  pathParts({ rawUrl: 'https://hnubs.netlify.app/.netlify/functions/chat-job/abc123' }, 'chat-job'), ['abc123']);
assert.deepStrictEqual(
  pathParts({ rawUrl: 'https://hnubs.netlify.app/api/analysis/jobs/j1' }, 'analysis-job'), ['j1']);
assert.deepStrictEqual(pathParts({ rawUrl: 'https://hnubs.netlify.app/api/chat' }, 'chat-job'), []);

// 2. 씬 개수는 제목 줄로 센다. 분할 조각 수로 세면 표지까지 한 씬이 된다.
const script = ['표지 없음', 'S#1 교실', '대사', 'S#2 복도', '대사', 'S#3 운동장'].join('\n');
assert.strictEqual(countHeadings(script), 3);
assert.strictEqual(sceneHeadings(script).length, 3);
assert.ok(splitScenes(script).length >= 1);

console.log('selfcheck OK');

// 3. 준비한 건수와 나열한 건수가 어긋나면 안 된다. 9건이면 9줄이 보여야 한다.
{
  const src = await import('node:fs').then(fs => fs.readFileSync('netlify/functions/chat.mjs', 'utf8'));
  const body = src.match(/function bulletList[\s\S]*?\n}/)[0];
  const bulletList = new Function(`${body}; return bulletList;`)();
  const nine = Array.from({ length: 9 }, (_, i) => i + 1);
  assert.strictEqual(bulletList(nine, n => `· ${n}`).split('\n').length, 9);
  const many = Array.from({ length: 25 }, (_, i) => i + 1);
  const cut = bulletList(many, n => `· ${n}`).split('\n');
  assert.strictEqual(cut.length, 21);
  assert.strictEqual(cut.at(-1), '· 외 5건');
}

console.log('bullet list OK');
