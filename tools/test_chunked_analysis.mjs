/* 대본 분석을 묶음 단위 요청으로 돌린다. 한 요청에 묶음 하나.
 *
 * 예전에는 서버가 백그라운드로 전부 돌았고, 실행 시간 제한이 있는 환경에서는
 * 중간에 잘려 작업이 '분석 중'인 채로 남았다. 이 테스트는 그 구조로 되돌아가는 걸 막는다.
 */
import assert from 'node:assert';
import fs from 'node:fs';

// ── 서버: 묶음 하나를 요청 안에서 끝내고 결과를 돌려준다
{
  const retry = fs.readFileSync('api/analysis-retry.mjs', 'utf8');
  assert(/await analyzeJob\(job, \[index\]\)/.test(retry),
    '묶음을 요청 안에서 처리하지 않는다');
  assert(!/dispatchAnalysis/.test(retry),
    '재시도가 아직 백그라운드로 넘긴다 — 무료 함수에서 30초에 잘린다');
  assert(/response\(200/.test(retry), '결과 대신 202(접수)만 돌려준다');

  const start = fs.readFileSync('api/analysis-start.mjs', 'utf8');
  assert(!/dispatchAnalysis/.test(start),
    '작업 시작이 아직 전체 분석을 백그라운드로 돌린다');
  assert(/response\(201/.test(start), '작업 생성 응답이 201 이 아니다');
}

// ── 화면: 묶음을 하나씩 돌고, 하나 실패해도 끝까지 간다
{
  const app = fs.readFileSync('app.js', 'utf8');
  assert(/async function runAiChunks\(jobId\)/.test(app), 'runAiChunks 가 없다');
  assert(!/pollAiJob/.test(app), '안 쓰는 폴링이 남아 있다');

  const body = app.slice(app.indexOf('async function runAiChunks'), app.indexOf('async function runAiChunks') + 1400);
  assert(/for \(let index = 0; index < total/.test(body), '묶음을 순회하지 않는다');
  assert(/catch \(error\)/.test(body), '한 묶음이 실패하면 전체가 멈춘다');
  assert(/status === 'success'\) continue/.test(body), '이미 끝난 묶음을 다시 분석한다');
  assert(/aiState\.job\?\.id !== jobId\) return/.test(body),
    '프로젝트를 바꿔도 이전 작업이 계속 돈다');
  assert(/await persistAiResult\(\)/.test(body), '끝나고 결과를 저장하지 않는다');
}

// ── 순회 로직만 떼어 와 실제로 돌려 본다
{
  const app = fs.readFileSync('app.js', 'utf8');
  const src = app.slice(app.indexOf('async function runAiChunks'));
  const fn = src.slice(0, src.indexOf('\n}\n') + 3);

  const calls = [];
  const make = (items, failAt = -1) => {
    const aiState = { job: { id: 'J', items: items.map(status => ({ status })) } };
    const apiJson = async (url) => {
      const index = Number(url.match(/retry\/(\d+)/)[1]);
      calls.push(index);
      if (index === failAt) throw new Error('묶음 실패');
      const next = JSON.parse(JSON.stringify(aiState.job));
      next.items[index].status = 'success';
      return next;
    };
    const ctx = { aiState, apiJson, render() {}, applyAutoCastMappings() {},
      persistAiResult: async () => { calls.push('저장'); },
      toast(t) { calls.push('알림:' + t); }, reportError() { calls.push('오류보고'); } };
    const run = new Function(...Object.keys(ctx), `${fn}\nreturn runAiChunks;`)(...Object.values(ctx));
    return { run, aiState };
  };

  // 전부 처음부터
  calls.length = 0;
  await make(['queued', 'queued', 'queued']).run('J');
  assert.deepEqual(calls.slice(0, 3), [0, 1, 2], '묶음을 순서대로 안 돈다');
  assert(calls.includes('저장'), '끝나고 저장하지 않는다');

  // 이미 끝난 묶음은 건너뛴다
  calls.length = 0;
  await make(['success', 'queued', 'success']).run('J');
  assert.deepEqual(calls.filter(x => typeof x === 'number'), [1], '끝난 묶음을 다시 분석한다');

  // 하나 실패해도 나머지를 계속한다
  calls.length = 0;
  await make(['queued', 'queued', 'queued'], 1).run('J');
  assert.deepEqual(calls.filter(x => typeof x === 'number'), [0, 1, 2],
    '한 묶음이 실패하자 나머지를 포기했다');
  assert(calls.includes('오류보고'), '실패를 조용히 삼켰다');
}
// ── 남은 묶음이 있으면 '완료'로 적지 않는다
{
  const shared = fs.readFileSync('api/_shared.mjs', 'utf8');
  const m = shared.match(/const pending = job\.items\.filter[\s\S]*?job\.status = [^;]+;/);
  assert(m, '남은 묶음을 보고 상태를 정하는 코드가 없다');

  const decide = (statuses, failures = 0, missing = 0) => {
    const job = { items: statuses.map(status => ({ status })) };
    return new Function('job', 'failures', 'missing',
      `${m[0]}
return job.status;`)(job, failures, missing);
  };

  assert.equal(decide(['success', 'queued']), 'running',
    '묶음이 남았는데 완료로 적는다 — 끊긴 작업이 끝난 것처럼 보인다');
  assert.equal(decide(['success', 'success']), 'completed');
  assert.equal(decide(['success', 'failed'], 1), 'partial');
  assert.equal(decide(['success', 'success'], 0, 3), 'partial', '누락 씬이 있으면 partial 이어야 한다');
  assert.equal(decide(['queued', 'queued']), 'running');
}
console.log('chunked analysis OK');
