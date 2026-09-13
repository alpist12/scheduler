const NETLIFY_ORIGIN = 'https://testserver111.netlify.app';
const MAINTENANCE_URL = 'https://firestore.googleapis.com/v1/projects/hnubs-2sceduler/databases/default/documents/settings/maintenance?key=AIzaSyDXmeiQpRSZshFA1_BgZ2z_8AKLy6_Nc8M';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

function decode(value) {
  if (!value) return null;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('stringValue' in value) return value.stringValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decode);
  if ('mapValue' in value) return Object.fromEntries(
    Object.entries(value.mapValue.fields || {}).map(([key, entry]) => [key, decode(entry)]),
  );
  return null;
}

function encode(value) {
  if (value == null) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value)
    ? { integerValue: String(value) }
    : { doubleValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  return { mapValue: { fields: Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, encode(entry)]),
  ) } };
}

async function readMaintenance() {
  const response = await fetch(MAINTENANCE_URL);
  if (response.status === 404) return {};
  if (!response.ok) throw new Error(`점검 상태 읽기 실패 (${response.status})`);
  return decode({ mapValue: { fields: (await response.json()).fields || {} } }) || {};
}

async function verifyMaintenancePassword(password) {
  const response = await fetch(`${NETLIFY_ORIGIN}/.netlify/functions/maintenance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'verify', password: String(password || '').trim() }),
  });
  if (!response.ok) return json(await response.json().catch(() => ({ error: '비밀번호 확인에 실패했습니다.' })), response.status);
  return null;
}

const publicMaintenance = state => ({
  blocked: Boolean(state.blocked),
  message: String(state.message || ''),
  since: String(state.since || ''),
});

async function maintenance(request) {
  if (request.method !== 'POST') return json({ error: 'POST 요청만 허용됩니다.' }, 405);
  let body;
  try { body = await request.json(); }
  catch { return json({ error: '요청 형식이 올바르지 않습니다.' }, 400); }

  try {
    const state = await readMaintenance();
    if (body.action === 'status') return json({ ok: true, ...publicMaintenance(state) });
    const denied = await verifyMaintenancePassword(body.password);
    if (denied) return denied;
    if (body.action === 'verify') return json({ ok: true, ...publicMaintenance(state) });
    if (body.action !== 'set') return json({ error: '알 수 없는 요청입니다.' }, 400);

    const next = {
      blocked: Boolean(body.blocked),
      message: String(body.message || '').slice(0, 200),
      since: body.blocked ? new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }) : '',
      logs: [
        { time: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }), text: body.blocked ? '점검 모드 시작' : '점검 모드 해제' },
        ...(Array.isArray(state.logs) ? state.logs : []),
      ].slice(0, 50),
    };
    const response = await fetch(MAINTENANCE_URL, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields: Object.fromEntries(Object.entries(next).map(([key, value]) => [key, encode(value)])) }),
    });
    if (!response.ok) throw new Error(`점검 상태 저장 실패 (${response.status})`);
    return json({ ok: true, ...publicMaintenance(next) });
  } catch (error) {
    return json({ error: error.message || String(error) }, 502);
  }
}

function upstreamUrl(requestUrl) {
  const source = new URL(requestUrl);
  const target = new URL(NETLIFY_ORIGIN);
  target.pathname = source.pathname === '/api/maintenance'
    ? '/.netlify/functions/maintenance'
    : `/scheduler${source.pathname}`;
  target.search = source.search;
  return target;
}

async function proxy(request) {
  const response = await fetch(new Request(upstreamUrl(request.url), request));
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export { upstreamUrl };

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/api/maintenance') return maintenance(request);
    if (path === '/api' || path.startsWith('/api/')) return proxy(request);

    if (env?.ASSETS?.fetch) {
      const local = await env.ASSETS.fetch(request);
      if (local.status !== 404) return local;
    }

    return proxy(request);
  },
};
