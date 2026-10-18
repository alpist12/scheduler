import assert from 'node:assert/strict';

const documents = new Map();
const requests = [];

const documentPath = url => decodeURI(new URL(url).pathname.split('/documents/')[1]);
const fieldPath = mask => mask.split('.').map(part => part.startsWith('`')
  ? part.slice(1, -1).replace(/\\([\\`])/g, '$1')
  : part);
const child = (fields, parts) => parts.reduce((value, part, index) =>
  index === 0 ? value?.[part] : value?.mapValue?.fields?.[part], fields);
const assign = (fields, parts, value) => {
  let target = fields;
  for (const part of parts.slice(0, -1)) {
    target[part] ??= { mapValue: { fields: {} } };
    target = target[part].mapValue.fields;
  }
  target[parts.at(-1)] = value;
};

globalThis.fetch = async (url, options = {}) => {
  const requestUrl = new URL(url);
  const path = documentPath(url);
  requests.push({ path, method: options.method || 'GET', url: requestUrl, body: options.body });
  if (!options.method) {
    const fields = documents.get(path);
    return fields
      ? { ok: true, status: 200, json: async () => ({ fields }) }
      : { ok: false, status: 404, json: async () => ({}) };
  }

  const incoming = JSON.parse(options.body).fields;
  const masks = requestUrl.searchParams.getAll('updateMask.fieldPaths');
  if (!masks.length) documents.set(path, incoming);
  else {
    const current = structuredClone(documents.get(path) || {});
    for (const mask of masks) {
      const parts = fieldPath(mask);
      assign(current, parts, child(incoming, parts));
    }
    documents.set(path, current);
  }
  return { ok: true, status: 200, text: async () => '' };
};

const { firebaseGet, firebasePatch, firebaseSet, normalizeCast, persistProjectAnalysis } = await import('../api/_shared.mjs');

const sample = {
  id: 'job-1', count: 3, ratio: 0.5, ready: true, empty: null,
  scenes: [{ tags: ['실내'], matrix: [[1, 2], [3]], items: ['실제 items 필드'], markerLike: { __arr: ['실제 __arr 필드'] } }],
};
await firebaseSet('scheduler/AI분석작업/job-1', sample);
assert.deepEqual(await firebaseGet('scheduler/AI분석작업/job-1'), sample);

documents.set('projects/p1', {
  name: { stringValue: '보존할 프로젝트' },
  color: { stringValue: '#123456' },
  aiAnalysis: { mapValue: { fields: { old: { stringValue: 'keep' } } } },
});
await firebasePatch('scheduler/프로젝트/p1/aiAnalysis', {
  activeJobId: 'job-1',
  'analysisJobs/job-1': sample,
});
assert.equal((await firebaseGet('scheduler/프로젝트/p1')).name, '보존할 프로젝트');
assert.equal((await firebaseGet('scheduler/프로젝트/p1')).color, '#123456');
assert.equal((await firebaseGet('scheduler/프로젝트/p1/aiAnalysis')).old, 'keep');
assert.deepEqual((await firebaseGet('scheduler/프로젝트/p1/aiAnalysis')).analysisJobs['job-1'], sample);

await persistProjectAnalysis({
  ...sample, projectId: 'p1', status: 'completed', progress: 100,
  sourceChunks: ['S#1'], items: [], logs: [], scenes: [], castMappings: [], updatedAt: '2026-09-10T00:00:00.000Z',
});
assert.equal(requests.some(request => request.url.hostname.endsWith('firebaseio.com')), false);

const analyzed = {
  crew: { planning: [{ id: 'p', name: '김기주' }], production: [{ id: 'v', name: '서창민' }] },
  items: [{ scenes: [
    { estimatedMinutes: 47, crew: { planning: ['가짜 기획'], production: ['가짜 촬영'] } },
    { estimatedMinutes: 0, crew: {} },
    { estimatedMinutes: 999, crew: {} },
  ] }],
};
normalizeCast(analyzed);
assert.deepEqual(analyzed.items[0].scenes[0].crew, analyzed.crew);
assert.deepEqual(analyzed.items[0].scenes.map(scene => scene.estimatedMinutes), [45, 30, 240]);

for (const [legacy, expected] of [
  ['scheduler/AI분석작업/a', 'analysisJobs/a'],
  ['scheduler/AI채팅작업/a', 'chatJobs/a'],
  ['scheduler/프로젝트/a', 'projects/a'],
  ['scheduler/촬영일정/a', 'shoots/a'],
  ['scheduler/점검', 'settings/maintenance'],
  ['scheduler/설정', 'settings/app'],
]) {
  await firebaseSet(legacy, { ok: true });
  assert.equal(requests.at(-1).path, expected);
}

console.log('Firestore 공용 계층: 경로 6종, 깊은 왕복, 병합 보존, 프로젝트 담당자·씬 예상시간 고정 통과');
