export const MODEL = process.env.NVIDIA_MODEL || 'openai/gpt-oss-20b';
export const CHAT_MODEL = process.env.NVIDIA_CHAT_MODEL || MODEL;
export const FALLBACK_MODEL = process.env.NVIDIA_FALLBACK_MODEL || 'nvidia/nemotron-3.5-lightning-30b-a3b';
export const API_BASE = (process.env.NVIDIA_API_BASE || 'https://integrate.api.nvidia.com').replace(/\/$/, '');
export const ANALYSIS_TIMEOUT_MS = 180000;

/* 화면과 API 가 다른 주소에 있으면(예: GitHub Pages ↔ Netlify) 브라우저가
   CORS 헤더를 요구한다. 헤더는 여기서 붙인다 — Netlify 는 이 핸들러를 바로
   부르고 worker 를 거치지 않으므로, 바깥에만 맡기면 아무도 안 붙인다.
   '*' 로 열지는 않는다. 이 API 는 관리자 비밀번호를 받고, 남이 부른
   NVIDIA 호출도 이쪽 요금이 된다. ALLOWED_ORIGINS 에 적힌 곳만 받는다. */
export const allowedOrigins = () => String(process.env.ALLOWED_ORIGINS || '')
  .split(',').map(x => x.trim().replace(/\/$/, '')).filter(Boolean);

export const corsFor = origin => {
  const clean = String(origin || '').replace(/\/$/, '');
  if (!clean || !allowedOrigins().includes(clean)) return {};
  return {
    'access-control-allow-origin': clean,
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
};

/* 브라우저는 본 요청 전에 OPTIONS 로 먼저 묻는다. 여기서 막히면 아무것도 안 된다.
   핸들러마다 맨 앞에서 이걸 부른다. */
export const preflight = event => {
  if (String(event?.httpMethod || '').toUpperCase() !== 'OPTIONS') return null;
  return { statusCode: 204, headers: corsFor(originOf(event)), body: '' };
};

export const originOf = event => {
  const h = event?.headers || {};
  return h.origin || h.Origin || '';
};

/* ── 호출량 제한 ──
   NVIDIA 호출은 돈이 든다. 인증이 없으면 주소만 알면 누구나 크레딧을 태울 수 있어서,
   IP 당 횟수를 막는다. 함수 인스턴스마다 따로 세므로 완벽하진 않지만,
   한 사람이 반복해서 긁는 것은 막는다. 제대로 막으려면 로그인이 필요하다. */
/* 플랫폼이 직접 넣는 헤더만 믿는다.
   x-forwarded-for 와 client-ip 는 브라우저가 아무 값이나 보낼 수 있어서,
   그걸 세면 매 요청마다 다른 IP 인 척해서 제한을 그냥 넘어간다.
   믿을 게 없으면 'unknown' 한 칸에 모아 센다 — 흩어지는 것보다 세게 막힌다. */
export const clientIp = event => String(
  // Cloudflare 경로: worker.mjs 가 cf-connecting-ip 를 읽어 여기에 직접 넣어 준다.
  event?.clientIp
  // Netlify 경로: 엣지가 넣는 헤더. 클라이언트가 보낸 값은 엣지가 덮어쓴다.
  // 헤더를 순서대로 시도하면 안 된다 — Netlify 에서는 cf-connecting-ip 를 아무나 보낼 수 있어서
  // 그걸 먼저 읽는 순간 제한이 그대로 뚫린다.
  || event?.headers?.['x-nf-client-connection-ip']
  || 'unknown',
).split(',')[0].trim();

const callLog = new Map();

/** 지나간 기록을 버린다. 안 버리면 인스턴스가 살아 있는 동안 계속 쌓인다. */
const CALL_LOG_MAX = 5000;
function sweep(now, windowMs) {
  if (callLog.size < 500) return;
  for (const [key, times] of callLog) {
    const left = times.filter(t => now - t < windowMs);
    if (left.length) callLog.set(key, left); else callLog.delete(key);
  }
  // 그래도 넘치면 오래된 것부터 버린다 (Map 은 넣은 순서를 지킨다).
  // 안 버리면 기록이 메모리를 계속 먹는다.
  while (callLog.size > CALL_LOG_MAX) callLog.delete(callLog.keys().next().value);
}

/**
 * @returns {number} 0 이면 통과, 양수면 몇 초 뒤에 다시 오라는 뜻.
 */
export function rateLimited(event, name, max, windowMs) {
  const now = Date.now();
  const key = `${name}:${clientIp(event)}`;
  const times = (callLog.get(key) || []).filter(t => now - t < windowMs);
  if (times.length >= max) {
    return Math.max(1, Math.ceil((windowMs - (now - times[0])) / 1000));
  }
  times.push(now);
  callLog.set(key, times);
  sweep(now, windowMs);
  return 0;
}

/** 제한에 걸렸을 때 돌려줄 응답. Retry-After 를 붙여 준다. */
export const tooMany = (retryAfter, event) => {
  const base = response(429, {
    error: `요청이 너무 잦습니다. ${retryAfter}초 뒤에 다시 시도해 주세요.`,
  }, event);
  return { ...base, headers: { ...base.headers, 'retry-after': String(retryAfter) } };
};

export const response = (statusCode, value, event) => ({
  statusCode,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...corsFor(originOf(event)),
  },
  body: JSON.stringify(value),
});

export const parseBody = event => {
  try { return JSON.parse(event.body || '{}'); }
  catch { throw new Error('요청 JSON 형식이 올바르지 않습니다.'); }
};

export function pathParts(event, functionName) {
  /* 리다이렉트를 거치면 함수가 보는 주소는 원래 요청 주소(/api/chat/jobs/xxx)라
     '/chat-job/' 같은 표시가 없다. 그럴 땐 /jobs/ 뒤를 읽는다. */
  const rawPath = new URL(event.rawUrl || `https://local${event.path || ''}`).pathname;
  const after = marker => rawPath.includes(marker) ? rawPath.split(marker).pop() : '';
  const suffix = after(`/${functionName}/`) || after('/jobs/');
  return suffix.split('/').filter(Boolean).map(decodeURIComponent);
}

/* ------------------------------------------------------------------ Firestore
   앱이 Firestore 로 옮겨갔으므로 함수도 같은 곳을 봐야 한다.
   호출부를 그대로 두려고 이름과 인자는 예전 그대로 두고 속만 바꾼다. */
const FS_PROJECT = process.env.FIREBASE_PROJECT_ID || 'hnubs-2sceduler';
const FS_DB = process.env.FIREBASE_FIRESTORE_DB || 'default';
const FS_KEY = String(process.env.FIREBASE_API_KEY || 'AIzaSyDXmeiQpRSZshFA1_BgZ2z_8AKLy6_Nc8M').trim();
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FS_PROJECT}/databases/${FS_DB}/documents`;

/* ── 서버 신원 ──
   공개 웹 API 키(?key=)로 쓰면 규칙을 거친다. 그래서 규칙이 열려 있는 동안은
   누구나 같은 경로에 직접 쓸 수 있고, 화면의 관리자 잠금이 의미를 잃는다.
   FIREBASE_SERVICE_ACCOUNT 를 주면 서비스 계정으로 토큰을 받아 Bearer 로 쓴다.
   서비스 계정은 규칙을 건너뛰므로, 규칙에서 scheduler/* 를 막아도 서버는 계속 쓴다.
   환경변수가 없으면 지금까지처럼 공개 키로 동작한다 (동작은 하되 보호는 없다). */
let saCache = null;        // { token, expires }
function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw);
    return sa.client_email && sa.private_key ? sa : null;
  } catch { throw new Error('FIREBASE_SERVICE_ACCOUNT 가 올바른 JSON 이 아닙니다.'); }
}

const b64url = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** 서비스 계정으로 액세스 토큰을 받는다. 만료 1분 전까지는 재사용한다. */
async function serviceToken() {
  const sa = serviceAccount();
  if (!sa) return null;
  if (saCache && saCache.expires > Date.now() + 60_000) return saCache.token;

  const { createSign } = await import('node:crypto');
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  };
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claim))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  // 환경변수에 넣을 때 줄바꿈이 \n 두 글자로 들어가는 일이 잦다. 진짜 줄바꿈으로 되돌린다.
  const pem = sa.private_key.includes('\\n') ? sa.private_key.replace(/\\n/g, '\n') : sa.private_key;
  const jwt = `${unsigned}.${b64url(signer.sign(pem))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!res.ok) throw new Error(`서비스 계정 토큰 발급 실패 (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  saCache = { token: body.access_token, expires: Date.now() + (body.expires_in || 3600) * 1000 };
  return saCache.token;
}

/** Firestore 요청에 붙일 주소와 헤더. 서비스 계정이 있으면 ?key= 대신 Bearer 를 쓴다. */
async function fsRequest(doc, query = '') {
  const token = await serviceToken();
  const sep = query ? '&' : '';
  if (token) {
    return { url: `${FS_BASE}/${doc}${query ? '?' + query : ''}`,
             headers: { authorization: `Bearer ${token}` } };
  }
  return { url: `${FS_BASE}/${doc}?key=${FS_KEY}${sep}${query}`, headers: {} };
}

/** RTDB 시절 경로를 Firestore 문서 경로로 옮긴다.
 *  분석 결과는 앱이 projects/{id} 의 aiAnalysis '필드' 로 읽으므로
 *  하위 컬렉션이 아니라 그 필드에 써야 한다. prefix 가 그 역할을 한다. */
/* 서비스 계정 토큰은 Firestore 규칙을 건너뛴다.
   그래서 id 에 경로를 끼워 넣으면 아무 문서나 읽고 쓸 수 있게 된다.
   (/api/analysis/jobs/:id 의 id 는 주소에서 그대로 온다)
   여기서 컬렉션과 문서 id 를 한 번 더 확인한다. */
const FS_COLLECTIONS = ['analysisJobs', 'chatJobs', 'projects', 'shoots', 'settings', 'members', 'notices'];
const FS_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** 주소에서 온 작업 ID 를 확인한다. 아니면 빈 문자열 — 호출부가 404 로 처리한다. */
export const safeId = value => (FS_ID.test(String(value || '')) ? String(value) : '');

function assertDoc(doc) {
  const parts = String(doc).split('/');
  if (parts.length !== 2) throw new Error('잘못된 문서 경로입니다.');
  const [collection, id] = parts;
  if (!FS_COLLECTIONS.includes(collection)) throw new Error('허용되지 않은 컬렉션입니다.');
  if (!FS_ID.test(id)) throw new Error('잘못된 문서 ID 입니다.');
  return doc;
}

function firestoreTarget(path) {
  const p = String(path || '').replace(/^\/+|\/+$/g, '');
  const analysis = p.match(/^scheduler\/프로젝트\/([^/]+)\/aiAnalysis$/);
  if (analysis) return { doc: assertDoc(`projects/${analysis[1]}`), prefix: 'aiAnalysis.' };
  return {
    doc: assertDoc(p
      .replace(/^scheduler\/AI분석작업\//, 'analysisJobs/')
      .replace(/^scheduler\/AI채팅작업\//, 'chatJobs/')
      .replace(/^scheduler\/프로젝트\//, 'projects/')
      .replace(/^scheduler\/촬영일정\//, 'shoots/')
      .replace(/^scheduler\/점검$/, 'settings/maintenance')
      .replace(/^scheduler\/설정$/, 'settings/app')),
    prefix: '',
  };
}

/** Firestore 는 값마다 타입을 붙인다. 배열 안의 배열은 허용하지 않는다. */
const NESTED_ARRAY_MARKER = '__hnubsNestedArrayV1';
function fsEncode(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(v => fsEncode(Array.isArray(v) ? { [NESTED_ARRAY_MARKER]: v } : v)) } };
  }
  if (typeof value === 'object') {
    return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fsEncode(v)])) } };
  }
  return { stringValue: String(value) };
}

function fsDecode(value) {
  if (!value || typeof value !== 'object') return null;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('stringValue' in value) return value.stringValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(fsDecode);
  if ('mapValue' in value) {
    const out = Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([k, v]) => [k, fsDecode(v)]));
    // 배열 안의 배열은 전용 표시자로 감싸 두었으니 되돌린다.
    return Object.keys(out).length === 1 && Array.isArray(out[NESTED_ARRAY_MARKER]) ? out[NESTED_ARRAY_MARKER] : out;
  }
  return null;
}

export async function firebaseGet(path) {
  const { doc, prefix } = firestoreTarget(path);
  const { url, headers } = await fsRequest(doc);
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;      // 없는 문서는 null 로 돌려주던 예전 동작을 지킨다
  if (!res.ok) throw new Error(`Firestore 읽기 실패 (${res.status})`);
  const body = await res.json();
  const value = fsDecode({ mapValue: { fields: body.fields || {} } });
  return prefix ? (value?.[prefix.slice(0, -1)] ?? null) : value;
}

/** RTDB PATCH 의 `parent/child` 키를 Firestore 중첩 맵으로 바꾼다. */
function nestedFields(value) {
  const out = {};
  for (const [key, entry] of Object.entries(value || {})) {
    const parts = key.split('/').filter(Boolean);
    let target = out;
    for (const part of parts.slice(0, -1)) target = target[part] ??= {};
    if (parts.length) target[parts.at(-1)] = entry;
  }
  return out;
}

/** 단순하지 않은 필드 이름은 Firestore field path 에서 백틱으로 감싼다. */
const maskName = key => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
  ? key
  : '`' + key.replace(/([\\`])/g, '\\$1') + '`';
const maskPath = key => key.split('/').filter(Boolean).map(maskName).join('.');

async function writeFields(path, value, replaceWhole) {
  const { doc, prefix } = firestoreTarget(path);
  const keys = Object.keys(value || {});
  const nested = nestedFields(value);
  const parent = prefix.slice(0, -1);
  // prefix 가 있으면 aiAnalysis.xxx 처럼 부분 필드만 건드린다.
  const fields = prefix
    ? { [parent]: fsEncode(nested) }
    : Object.fromEntries(Object.entries(nested).map(([k, v]) => [k, fsEncode(v)]));
  const paths = prefix
    ? (replaceWhole ? [maskName(parent)] : keys.map(k => `${maskName(parent)}.${maskPath(k)}`))
    : (replaceWhole ? [] : keys.map(maskPath));
  const mask = paths.map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const { url, headers } = await fsRequest(doc, mask);
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`Firestore 저장 실패 (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return value;
}

// 예전 PUT 처럼 문서를 통째로 바꾼다.
export const firebaseSet = (path, value) => writeFields(path, value, true);
// 예전 PATCH 처럼 준 필드만 바꾼다.
export const firebasePatch = (path, value) => writeFields(path, value, false);

export async function dispatchAnalysis(event, id, indexes = null) {
  if (typeof event.dispatchAnalysis === 'function') return event.dispatchAnalysis(id, indexes);
  const origin = new URL(event.rawUrl || `https://${event.headers?.host || event.headers?.Host}`).origin;
  const res = await fetch(`${origin}/.api/analysis-run-background`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, indexes }),
  });
  if (!res.ok) throw new Error(`백그라운드 분석 시작 실패 (${res.status})`);
}

export async function dispatchChat(event, id) {
  if (typeof event.dispatchChat === 'function') return event.dispatchChat(id);
  const origin = new URL(event.rawUrl || `https://${event.headers?.host || event.headers?.Host}`).origin;
  const res = await fetch(`${origin}/.api/chat-run-background`, {
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

const sceneHeading = /^(?=[ \t]*(?:S[ \t]*#?[ \t]*\d+|SCENE[ \t]*\d+|씬[ \t]*\d+|장면[ \t]*\d+|(?:INT|EXT|실내|실외)[. \t/]))/gim;
export function sceneHeadings(text) {
  return String(text || '').replace(/\r\n?/g, '\n').split('\n')
    .filter(line => /^[ \t]*(?:S[ \t]*#?[ \t]*\d+|SCENE[ \t]*\d+|씬[ \t]*\d+|장면[ \t]*\d+|(?:INT|EXT|실내|실외)[. \t/])/i.test(line));
}
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
    } else if (current && (current.length + part.length + 2 > maxChars || countHeadings(current) + countHeadings(part) > 4)) {
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
  '정확도 우선': { maxChars: 6000, temperature: 0.05 },
  '균형 (추천)': { maxChars: 11000, temperature: 0.1 },
  '속도 우선':   { maxChars: 18000, temperature: 0.2 },
};
export const precisionOf = name => PRECISION[name] || PRECISION['균형 (추천)'];

const systemPrompt = `당신은 방송 제작 대본을 구조화하는 분석기입니다. 제공된 원문에 있는 사실만 사용하세요.
반드시 JSON 객체 하나만 반환하세요. 스키마:
{"castMappings":[{"character":"역할명","person":"출연배우명"}],"scenes":[{"sceneId":"S#1","location":"","interiorExterior":"INT|EXT|UNKNOWN","dayNight":"DAY|NIGHT|UNKNOWN","characters":[],"speakingCharacters":[],"summary":"","estimatedMinutes":0,"crew":{"planning":[],"production":[]}}]}
첫 페이지나 표지에 역할명과 출연배우명이 표, 목록, 괄호, 콜론, 화살표 등 어떤 형식으로 적혀 있어도 castMappings에 추출하세요.
scenes.characters에는 배우 이름이 아니라 대본의 역할명을 유지하세요.
원문의 씬 개수만큼 빠짐없이 반환하세요. 짧은 씬, 대사가 없는 씬도 각각 독립된 객체로 반환하세요.
같은 장소나 같은 번호가 반복되어도 서로 다른 씬이면 합치지 마세요. 표지·배역표·기획의도는 씬으로 세지 마세요.
반환 전 제공된 씬 목록과 결과를 순서대로 대조하여 누락이 없는지 확인하세요. 장황한 요약보다 모든 씬 보존이 우선입니다.
location 은 씬 제목 줄에 적힌 장소를 그대로 씁니다.
실내/실외와 낮/밤은 씬 제목이나 지문에 단서가 있을 때만 채우고, 없으면 UNKNOWN 으로 둡니다.
estimatedMinutes 는 영상 러닝타임이 아니라 실제 현장 촬영 예상시간입니다.
대사량, 출연 인원, 동선·액션, 장소 전환, 소품·분장·조명 세팅과 반복 테이크를 함께 고려해 5분 단위의 10~240분 정수로 추정하세요.
정보가 부족한 짧은 씬도 0으로 두지 말고 30분을 기본값으로 사용하세요.
위 estimatedMinutes 규칙을 제외한 값을 추측하지 말고, 모르는 값은 빈 문자열, 빈 배열, UNKNOWN 또는 0으로 두세요.`;

/** 프로젝트에 지정된 역할 인원을 프롬프트에 덧붙인다.
 *  기획·촬영은 모든 씬에 반드시 배정되어야 하므로 그 규칙도 함께 알린다. */
function crewPrompt(crew) {
  if (!crew || typeof crew !== 'object') return '';
  const list = k => (Array.isArray(crew[k]) ? crew[k] : []).filter(Boolean);
  const planning = list('planning'), production = list('production'), cast = list('cast');
  const castMappings = Array.isArray(crew.castMappings) ? crew.castMappings : [];
  if (!planning.length && !production.length && !cast.length && !castMappings.length) return '';
  const out = ['', '[이 프로젝트의 역할별 인원]'];
  if (planning.length) out.push(`기획: ${planning.join(', ')}`);
  if (production.length) out.push(`촬영/편집: ${production.join(', ')}`);
  if (cast.length) out.push(`출연: ${cast.join(', ')}`);
  if (castMappings.length) {
    out.push('[원문 첫 페이지 배역표 — 모든 씬에서 이 연결을 유지할 것]');
    out.push(...castMappings.map(x => `${x.character} → ${x.person}`));
    out.push('대사에서 성을 생략한 이름도 배역표의 전체 역할명으로 통일하세요. 배우를 추측하거나 서로 바꾸지 마세요.');
  }
  out.push('');
  out.push('규칙: 모든 씬에는 기획 담당과 촬영/편집 담당이 반드시 1명 이상 있어야 합니다.');
  out.push('각 씬의 "crew" 에 {"planning":[],"production":[]} 형태로 담당자를 배정하고,');
  out.push('위 명단이 비어 있어 배정할 수 없으면 해당 항목을 빈 배열로 두세요.');
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
      if (Array.isArray(value.scenes)) return { scenes: value.scenes, castMappings: Array.isArray(value.castMappings) ? value.castMappings : [] };
    } catch { /* 아래에서 부분 복구를 시도한다 */ }
  }
  const salvaged = salvageScenes(text);
  if (salvaged) return { scenes: salvaged, castMappings: [] };
  throw new Error('NIM 응답 JSON이 손상되었습니다.');
}

export async function callNim(chunk, index, total, precision, crew) {
  const key = String(process.env.NVIDIA_API_KEY || '').trim();
  if (!key) throw new Error('서버 환경변수 NVIDIA_API_KEY가 없습니다.');
  let lastError;
  let activeModel = MODEL;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(`${API_BASE}/v1/chat/completions`, {
        signal: AbortSignal.timeout(ANALYSIS_TIMEOUT_MS),
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: activeModel, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: `대본 묶음 ${index}/${total}${crewPrompt(crew)}\n[원문 씬 목록: ${countHeadings(chunk)}개]\n${sceneHeadings(chunk).map((h,i) => `${i + 1}. ${h.trim()}`).join('\n')}\n위 목록이 있으면 각 항목을 순서대로 하나씩 반환하세요. 중복 번호도 별도 씬입니다.\n\n${chunk}` }], response_format: { type: 'json_object' }, chat_template_kwargs: { enable_thinking: false }, temperature: precisionOf(precision).temperature, top_p: 0.8, max_tokens: 8192, stream: false }),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 500);
        if ([404, 410].includes(res.status) && activeModel !== FALLBACK_MODEL) {
          activeModel = FALLBACK_MODEL;
          continue;
        }
        const error = new Error(`NIM HTTP ${res.status}: ${detail}`);
        error.retryable = res.status === 429 || res.status >= 500;
        throw error;
      }
      const result = await res.json();
      return { ...parseNimJson(result?.choices?.[0]?.message?.content), model: activeModel };
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw new Error('AI 분석 요청이 180초를 초과했습니다. 완료된 결과는 유지되며 실패한 묶음만 다시 시도할 수 있습니다.');
      }
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

/** 원문의 씬 개수를 센다. 결과 씬 수와 비교해 누락을 잡아내는 기준이 된다.
 *  0-너비 정규식은 빈 줄에서도 매칭되므로 splitScenes 와 같은 기준(분할 조각 수)으로 센다. */
export function countHeadings(text) {
  return sceneHeadings(text).length;
}

export function sourceCastMappings(text) {
  const cover = String(text || '').split(sceneHeading)[0];
  return cover.split(/\r?\n/).flatMap(line => {
    const m = line.trim().match(/^([가-힣]{2,10})\s*(?:[-–—:：]|→)\s*([가-힣]{2,10})\s*$/);
    return m && !/기획|촬영|편집|제작|감독|연출/.test(m[1]) ? [{character:m[1],person:m[2]}] : [];
  });
}

export function normalizeCast(job) {
  const source = sourceCastMappings((job.sourceChunks || []).join('\n\n'));
  const canonical = name => {
    const exact = source.find(x => x.character === name);
    if (exact) return exact.character;
    const matches = source.filter(x => String(name).length >= 2 && x.character.endsWith(name));
    return matches.length === 1 ? matches[0].character : name;
  };
  for (const item of job.items || []) {
    for (const scene of item.scenes || []) {
      const minutes = Math.round(Number(scene.estimatedMinutes));
      scene.estimatedMinutes = Number.isFinite(minutes) && minutes > 0
        ? Math.min(240, Math.max(10, Math.round(minutes / 5) * 5))
        : 30;
      for (const key of ['characters','speakingCharacters','backgroundCharacters']) {
        if (source.length && Array.isArray(scene[key])) scene[key] = [...new Set(scene[key].map(canonical))];
      }
      // 모델이 다른 담당자를 만들어도 요청 당시 프로젝트 담당자로 고정한다.
      scene.crew = { ...(scene.crew || {}),
        planning: Array.isArray(job.crew?.planning) ? job.crew.planning : [],
        production: Array.isArray(job.crew?.production) ? job.crew.production : [] };
    }
    if (source.length) item.castMappings = source;
  }
}

/** 진행 상황을 즉시 반영한다. 저장이 실패해도 분석은 계속한다. */
async function saveProgress(job) {
  normalizeCast(job);
  const done = job.items.filter(x => ['success', 'failed', 'incomplete'].includes(x.status)).length;
  job.progress = Math.round(done / Math.max(1, job.items.length) * 100);
  job.scenes = job.items.flatMap(x => x.scenes || []);
  job.castMappings = job.items.flatMap(x => x.castMappings || []);
  job.updatedAt = new Date().toISOString();
  try { await firebaseSet(`scheduler/AI분석작업/${job.id}`, job); } catch { /* 다음 저장에서 따라잡는다 */ }
}

// 브라우저가 닫혀도 서버가 결과를 프로젝트 이력에 남긴다. 다른 분석의 활성 결과는 덮지 않는다.
export async function persistProjectAnalysis(job) {
  if (!job.projectId) return;
  const path = `scheduler/프로젝트/${job.projectId}/aiAnalysis`;
  const previous = await firebaseGet(path) || {};
  const safe = publicJob(job);
  const patch = { [`analysisJobs/${job.id}`]: safe };
  if (!previous.activeJobId || previous.activeJobId === job.id) {
    Object.assign(patch, { activeJobId: job.id, job: safe, scenes: job.scenes || [],
      castMappings: job.castMappings || [], updatedAt: job.updatedAt,
      provider: 'NVIDIA NIM', model: job.model || MODEL, elapsedMs: job.elapsedMs || 0,
      missingScenes: job.missingScenes || 0 });
  }
  await firebasePatch(path, patch);
}

/** 한 묶음을 분석한다. 씬이 모자라면(출력 잘림) 반으로 쪼개 다시 시도한다. */
async function analyzeChunk(job, chunk, index, total, depth = 0) {
  const mappings = sourceCastMappings((job.sourceChunks || []).join('\n\n'));
  const crew = { ...(job.crew || {}), castMappings: mappings };
  const analyzed = await callNim(chunk, index + 1, total, job.precision, crew);
  const scenes = analyzed.scenes;
  const expected = countHeadings(chunk);
  if (expected <= scenes.length || depth >= 2) return { scenes, castMappings: analyzed.castMappings, expected, model: analyzed.model };

  // 출력이 잘려 씬이 빠졌다. 더 잘게 나누면 한 번에 만들 JSON 이 짧아져 잘리지 않는다.
  log(job, `묶음 ${index + 1}: 씬 ${expected}개 중 ${scenes.length}개만 나옴 · 더 잘게 나눠 재시도`, 'warn');
  await saveProgress(job);
  const halves = splitScenes(chunk, Math.max(1500, Math.ceil(chunk.length / 2)));
  if (halves.length < 2) return { scenes, castMappings: analyzed.castMappings, expected, model: analyzed.model };
  const merged = [], castMappings = [...analyzed.castMappings];
  for (const half of halves) {
    try {
      const part = await analyzeChunk(job, half, index, total, depth + 1);
      merged.push(...part.scenes);
      castMappings.push(...(part.castMappings || []));
    } catch (error) {
      log(job, `묶음 ${index + 1} 재시도 일부 실패 · ${error.message}`, 'warn');
    }
  }
  return { scenes: merged.length > scenes.length ? merged : scenes, castMappings, expected, model: analyzed.model };
}

export async function analyzeJob(job, indexes = null) {
  const jobStartedAt = Date.now();
  job.status = 'running';
  const targets = indexes || job.sourceChunks.map((_, i) => i);
  for (const index of targets) {
    const item = job.items[index]; item.status = 'running'; item.error = null;
    const startedAt = Date.now();
    log(job, `대본 묶음 ${index + 1}/${job.sourceChunks.length} 분석 시작 · ${job.sourceChunks[index].length.toLocaleString()}자`);
    await saveProgress(job);   // 시작 사실을 바로 보여준다
    try {
      const { scenes, castMappings, expected, model } = await analyzeChunk(job, job.sourceChunks[index], index, job.sourceChunks.length);
      job.model = model || job.model || MODEL;
      item.scenes = scenes.map((scene, offset) => ({ ...scene, sceneId: scene.sceneId || `S#${index + 1}-${offset + 1}`, sourceChunk: index }));
      item.castMappings = castMappings || [];
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
  const done = job.items.filter(x => ['success', 'failed', 'incomplete'].includes(x.status)).length;
  const failures = job.items.filter(x => x.status === 'failed').length;
  const missing = job.items.reduce((n, x) => n + (x.missing || 0), 0);
  job.progress = Math.round(done / Math.max(1, job.items.length) * 100);
  job.scenes = job.items.flatMap(x => x.scenes || []);
  job.castMappings = [...new Map(job.items.flatMap(x => x.castMappings || []).filter(x => x?.character && x?.person).map(x => [`${x.character}\u0000${x.person}`, x])).values()];
  job.missingScenes = missing;
  job.elapsedMs = (job.elapsedMs || 0) + (Date.now() - jobStartedAt);   // 재시도분까지 누적
  /* 묶음을 하나씩 처리하므로, 아직 손대지 않은 묶음이 남았는데 '완료'로 적으면
     중간에 끊긴 작업이 끝난 것처럼 보이고 화면이 이어서 돌리지 않는다. */
  const pending = job.items.filter(x => !['success', 'failed', 'incomplete'].includes(x.status)).length;
  job.status = pending ? 'running' : (failures || missing) ? 'partial' : 'completed';
  job.updatedAt = new Date().toISOString();
  log(job, `분석 종료 · 성공 ${job.items.length - failures}, 실패 ${failures}${missing ? `, 누락 씬 ${missing}개` : ''} · 총 ${Math.round(job.elapsedMs / 1000)}초`,
    (failures || missing) ? 'warn' : 'success');
  await firebaseSet(`scheduler/AI분석작업/${job.id}`, job);
  await persistProjectAnalysis(job);
  return job;
}
