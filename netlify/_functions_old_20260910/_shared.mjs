const DB_URL = (process.env.FIREBASE_DATABASE_URL || 'https://hnubs-2sceduler-default-rtdb.firebaseio.com').replace(/\/$/, '');
export const MODEL = process.env.NVIDIA_MODEL || 'nvidia/nemotron-3-super-120b-a12b';
export const API_BASE = (process.env.NVIDIA_API_BASE || 'https://integrate.api.nvidia.com').replace(/\/$/, '');

export const response = (statusCode, value) => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  body: JSON.stringify(value),
});

export const parseBody = event => {
  try { return JSON.parse(event.body || '{}'); }
  catch { throw new Error('요청 JSON 형식이 올바르지 않습니다.'); }
};

export function pathParts(event, functionName) {
  const rawPath = new URL(event.rawUrl || `https://local${event.path || ''}`).pathname;
  const marker = `/${functionName}/`;
  const suffix = rawPath.includes(marker) ? rawPath.split(marker).pop() : '';
  return suffix.split('/').filter(Boolean).map(decodeURIComponent);
}

export async function firebaseGet(path) {
  const res = await fetch(`${DB_URL}/${path}.json`);
  if (!res.ok) throw new Error(`Firebase 읽기 실패 (${res.status})`);
  return res.json();
}

export async function firebaseSet(path, value) {
  const res = await fetch(`${DB_URL}/${path}.json`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  if (!res.ok) throw new Error(`Firebase 저장 실패 (${res.status})`);
  return value;
}

export async function dispatchChat(event, id) {
  const origin = new URL(event.rawUrl || `https://${event.headers?.host || event.headers?.Host}`).origin;
  const res = await fetch(`${origin}/.netlify/functions/chat-run-background`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(`백그라운드 응답 시작 실패 (${res.status})`);
}

export function publicJob(job) {
  if (!job) return job;
  const { sourceChunks, ...safeJob } = job;
  return safeJob;
}

const sceneHeading = /^(?=\s*(?:S\s*#?\s*\d+|SCENE\s*\d+|씬\s*\d+|장면\s*\d+|(?:INT|EXT|실내|실외)[.\s/]))/gim;
export function splitScenes(text, maxChars = 11000) {
  const cleaned = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!cleaned) return [];
  let parts = cleaned.split(sceneHeading).map(x => x.trim()).filter(Boolean);
  if (parts.length <= 1) {
    const paragraphs = cleaned.split(/\n{2,}/).map(x => x.trim()).filter(Boolean);
    parts = []; let current = '';
    for (const paragraph of paragraphs) {
      if (current && current.length + paragraph.length + 2 > maxChars) { parts.push(current); current = paragraph; }
      else current = `${current}\n\n${paragraph}`.trim();
    }
    if (current) parts.push(current);
  }
  // 연속한 씬을 maxChars 까지 한 묶음으로 합친다. 묶음이 클수록 API 호출이 줄어 빨라진다.
  const chunks = [];
  let current = '';
  for (const part of parts) {
    if (part.length > maxChars) {
      if (current) { chunks.push(current); current = ''; }
      for (let i = 0; i < part.length; i += maxChars) chunks.push(part.slice(i, i + maxChars));
    } else if (current && current.length + part.length + 2 > maxChars) {
      chunks.push(current); current = part;
    } else {
      current = `${current}\n\n${part}`.trim();
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// 분석 정밀도 설정. 묶음이 작을수록 놓치는 장면이 줄지만 API 호출이 늘어 느려진다.
export const PRECISION = {
  '정확도 우선': { maxChars: 1800, temperature: 0.05 },
  '균형 (추천)': { maxChars: 3000, temperature: 0.1 },
  '속도 우선':   { maxChars: 6000, temperature: 0.2 },
};
export const precisionOf = name => PRECISION[name] || PRECISION['균형 (추천)'];

const systemPrompt = `당신은 방송 제작 대본을 구조화하는 분석기입니다. 제공된 원문에 있는 사실만 사용하세요.
반드시 JSON 객체 하나만 반환하세요. 스키마:
{"scenes":[{"sceneId":"S#1","title":"","location":"","characters":[],"speakingCharacters":[],"summary":"","estimatedMinutes":0,"crew":{"planning":[],"production":[]}}]}
추측하지 말고 모르는 값은 빈 문자열, 빈 배열, UNKNOWN 또는 0으로 두세요.`;

/** 프로젝트에 지정된 역할 인원을 프롬프트에 덧붙인다.
 *  기획·촬영은 모든 씬에 반드시 배정되어야 하므로 그 규칙도 함께 알린다. */
function crewPrompt(crew) {
  if (!crew || typeof crew !== 'object') return '';
  const list = k => (Array.isArray(crew[k]) ? crew[k] : []).filter(Boolean);
  const planning = list('planning'), production = list('production'), cast = list('cast');
  if (!planning.length && !production.length && !cast.length) return '';
  const out = ['', '[이 프로젝트의 역할별 인원]'];
  if (planning.length) out.push(`기획: ${planning.join(', ')}`);
  if (production.length) out.push(`촬영/편집: ${production.join(', ')}`);
  if (cast.length) out.push(`출연: ${cast.join(', ')}`);
  out.push('');
  out.push('규칙: 모든 씬에는 기획 담당과 촬영/편집 담당이 반드시 1명 이상 있어야 합니다.');
  out.push('각 씬의 "crew" 에 {"planning":[],"production":[]} 형태로 담당자를 배정하고,');
  out.push('위 명단이 비어 있으면 해당 항목을 빈 배열로 두세요.');
  out.push('한 사람이 여러 역할을 겸할 수 있습니다. 기획이나 촬영/편집 담당이 출연도 하면 "characters" 에도 함께 넣으세요.');
  out.push('"characters" 는 대본 기준으로 뽑고, 위 명단과 이름이 같으면 같은 사람으로 봅니다.');
  return out.join(String.fromCharCode(10));
}

/** 모델 출력이 토큰 상한에서 잘리면 JSON 이 깨진다.
 *  통째로 버리지 말고 완성된 씬까지만 살려낸다. */
function salvageScenes(text) {
  const open = text.indexOf('[', text.indexOf('"scenes"'));
  if (open < 0) return null;
  const scenes = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = open + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth += 1; continue; }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try { scenes.push(JSON.parse(text.slice(start, i + 1))); } catch { /* 깨진 씬은 버린다 */ }
        start = -1;
      }
    }
  }
  return scenes.length ? scenes : null;
}

function parseNimJson(content) {
  let text = String(content || '').trim().replace(/^```(?:json)?\s*|\s*```$/gis, '');
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0) throw new Error('NIM 응답에서 JSON을 찾지 못했습니다.');
  if (end > start) {
    try {
      const value = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(value.scenes)) return value.scenes;
    } catch { /* 아래에서 부분 복구를 시도한다 */ }
  }
  const salvaged = salvageScenes(text);
  if (salvaged) return salvaged;
  throw new Error('NIM 응답 JSON이 손상되었습니다.');
}

export async function callNim(chunk, index, total, precision, crew) {
  const key = String(process.env.NVIDIA_API_KEY || '').trim();
  if (!key) throw new Error('Netlify Functions 환경변수 NVIDIA_API_KEY가 없습니다.');
  // 모델이 씬을 빠뜨리는 일이 잦다. 원문 씬 수를 알려주고 개수를 맞추게 한다.
  const expected = countHeadings(chunk);
  const quota = expected ? `이 묶음에는 씬이 ${expected}개 있습니다. 하나도 합치거나 건너뛰지 말고 정확히 ${expected}개를 출력하세요.${String.fromCharCode(10)}` : '';
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(`${API_BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: `대본 묶음 ${index}/${total}${crewPrompt(crew)}\n${quota}\n${chunk}` }], temperature: precisionOf(precision).temperature, top_p: 0.8, max_tokens: 8192, stream: false }),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 500);
        const error = new Error(`NIM HTTP ${res.status}: ${detail}`);
        error.retryable = res.status === 429 || res.status >= 500;
        throw error;
      }
      const result = await res.json();
      return parseNimJson(result?.choices?.[0]?.message?.content);
    } catch (error) {
      lastError = error;
      const retryable = error.retryable !== false && (error.retryable || error instanceof SyntaxError || /JSON|fetch|network|timeout/i.test(error.message));
      if (!retryable || attempt === 3) break;
      await new Promise(resolve => setTimeout(resolve, attempt * 900));
    }
  }
  throw lastError;
}

const time = () => new Date().toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Seoul' });
const log = (job, message, level = 'info') => job.logs.push({ time: time(), level, message });

export function sceneHeadings(text) {
  return String(text || '').replace(/\r\n?/g, '\n').split('\n')
    .filter(line => /^[ \t]*(?:S[ \t]*#?[ \t]*\d+|SCENE[ \t]*\d+|씬[ \t]*\d+|장면[ \t]*\d+|(?:INT|EXT|실내|실외)[. \t/])/i.test(line));
}

/** 원문의 씬 개수를 센다. 결과 씬 수와 비교해 누락을 잡아내는 기준이 된다.
 *  분할 조각 수를 세면 첫 씬 앞의 머리말까지 1개로 잡혀 실제보다 하나 많아진다. */
export function countHeadings(text) {
  return sceneHeadings(text).length;
}

/** 진행 상황을 즉시 반영한다. 저장이 실패해도 분석은 계속한다. */
async function saveProgress(job) {
  const done = job.items.filter(x => ['success', 'failed', 'incomplete'].includes(x.status)).length;
  job.progress = Math.round(done / Math.max(1, job.items.length) * 100);
  job.scenes = job.items.flatMap(x => x.scenes || []);
  job.updatedAt = new Date().toISOString();
  try { await firebaseSet(`scheduler/AI분석작업/${job.id}`, job); } catch { /* 다음 저장에서 따라잡는다 */ }
}

/** 한 묶음을 분석한다. 씬이 모자라면(출력 잘림) 반으로 쪼개 다시 시도한다. */
async function analyzeChunk(job, chunk, index, total, depth = 0) {
  const scenes = await callNim(chunk, index + 1, total, job.precision, job.crew);
  const expected = countHeadings(chunk);
  if (expected <= scenes.length || depth >= 2) return { scenes, expected };

  // 출력이 잘려 씬이 빠졌다. 더 잘게 나누면 한 번에 만들 JSON 이 짧아져 잘리지 않는다.
  log(job, `묶음 ${index + 1}: 씬 ${expected}개 중 ${scenes.length}개만 나옴 · 더 잘게 나눠 재시도`, 'warn');
  await saveProgress(job);
  const halves = splitScenes(chunk, Math.max(1500, Math.ceil(chunk.length / 2)));
  if (halves.length < 2) return { scenes, expected };
  const merged = [];
  for (const half of halves) {
    try {
      const part = await analyzeChunk(job, half, index, total, depth + 1);
      merged.push(...part.scenes);
    } catch (error) {
      log(job, `묶음 ${index + 1} 재시도 일부 실패 · ${error.message}`, 'warn');
    }
  }
  return { scenes: merged.length > scenes.length ? merged : scenes, expected };
}

/** 묶음 하나를 처리하고 결과를 item 에 채운다. (순차/병렬 공용) */
async function runOne(job, index) {
  const item = job.items[index]; item.status = 'running'; item.error = null;
  const startedAt = Date.now();
  log(job, `대본 묶음 ${index + 1}/${job.sourceChunks.length} 분석 시작 · ${job.sourceChunks[index].length.toLocaleString()}자`);
  try {
      const { scenes, expected } = await analyzeChunk(job, job.sourceChunks[index], index, job.sourceChunks.length);
      item.scenes = scenes.map((scene, offset) => ({ ...scene, sceneId: scene.sceneId || `S#${index + 1}-${offset + 1}`, sourceChunk: index }));
      item.expected = expected;
      item.missing = Math.max(0, expected - item.scenes.length);
      const took = Math.round((Date.now() - startedAt) / 1000);
      if (item.missing) {
        // 조용히 넘어가지 않는다. 몇 개가 빠졌는지 남긴다.
        item.status = 'incomplete';
        item.error = `씬 ${expected}개 중 ${item.scenes.length}개만 분석됨 (${item.missing}개 누락)`;
        log(job, `대본 묶음 ${index + 1} 불완전 · ${item.error} · ${took}초`, 'warn');
      } else {
        item.status = 'success';
        log(job, `대본 묶음 ${index + 1} 완료 · ${item.scenes.length}개 장면 · ${took}초`);
      }
    } catch (error) {
      item.status = 'failed'; item.error = error.message;
      log(job, `대본 묶음 ${index + 1} 실패 · ${error.message} · ${Math.round((Date.now() - startedAt) / 1000)}초`, 'error');
    }
  await saveProgress(job);   // 묶음이 끝날 때마다 화면에 반영
}

export async function analyzeJob(job, indexes = null) {
  const jobStartedAt = Date.now();
  job.status = 'running';
  const targets = indexes || job.sourceChunks.map((_, i) => i);
  await saveProgress(job);
  // 묶음을 최대 3개씩 동시에 보낸다. NIM 동시 호출 제한을 넘지 않으면서 대기 시간을 줄인다.
  const LANES = 3;
  const queue = [...targets];
  await Promise.all(Array.from({ length: Math.min(LANES, queue.length) }, async () => {
    while (queue.length) {
      const index = queue.shift();
      if (index === undefined) return;
      await runOne(job, index);
    }
  }));
  const done = job.items.filter(x => ['success', 'failed', 'incomplete'].includes(x.status)).length;
  const failures = job.items.filter(x => x.status === 'failed').length;
  const missing = job.items.reduce((n, x) => n + (x.missing || 0), 0);
  job.progress = Math.round(done / Math.max(1, job.items.length) * 100);
  job.scenes = job.items.flatMap(x => x.scenes || []);
  job.missingScenes = missing;
  job.elapsedMs = (job.elapsedMs || 0) + (Date.now() - jobStartedAt);   // 재시도분까지 누적
  job.status = (failures || missing) ? 'partial' : 'completed'; job.updatedAt = new Date().toISOString();
  log(job, `분석 종료 · 성공 ${job.items.length - failures}, 실패 ${failures}${missing ? `, 누락 씬 ${missing}개` : ''} · 총 ${Math.round(job.elapsedMs / 1000)}초`,
    (failures || missing) ? 'warn' : 'success');
  await firebaseSet(`scheduler/AI분석작업/${job.id}`, job);
  return job;
}
