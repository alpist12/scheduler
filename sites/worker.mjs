import { handler as maintenance } from '../api/maintenance.mjs';
import { handler as health } from '../api/health.mjs';
import { handler as extract } from '../api/extract.mjs';
import { handler as chat } from '../api/chat.mjs';
import { handler as chatJob } from '../api/chat-job.mjs';
import { handler as chatBackground } from '../api/chat-run-background.mjs';
import { handler as analysisStart } from '../api/analysis-start.mjs';
import { handler as analysisJob } from '../api/analysis-job.mjs';
import { handler as analysisRetry } from '../api/analysis-retry.mjs';
import { handler as analysisBackground } from '../api/analysis-run-background.mjs';

/* 화면(정적 호스팅)과 이 API 가 서로 다른 출처에 있으면 브라우저가 응답을 버린다.
   ALLOWED_ORIGINS 에 적힌 주소만 통과시킨다. 비워 두면 같은 출처만 쓴다는 뜻이라
   헤더를 붙이지 않는다. '*' 로 열지 않는 이유: 이 API 는 관리자 비밀번호를 받는다. */
function allowOrigin(request) {
  const origin = request.headers.get('origin') || '';
  if (!origin) return '';
  const allowed = String(process.env.ALLOWED_ORIGINS || '')
    .split(',').map(x => x.trim().replace(/\/$/, '')).filter(Boolean);
  return allowed.includes(origin.replace(/\/$/, '')) ? origin : '';
}

function corsHeaders(origin) {
  return origin ? {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-max-age': '86400',
    vary: 'origin',
  } : {};
}

function response(result, origin = '') {
  return new Response(result?.body || '', {
    status: result?.statusCode || 200,
    headers: {
      ...(result?.headers || { 'content-type': 'application/json; charset=utf-8' }),
      ...corsHeaders(origin),
    },
  });
}

async function eventOf(request, context) {
  const url = new URL(request.url);
  const event = {
    rawUrl: request.url,
    path: url.pathname,
    httpMethod: request.method,
    headers: Object.fromEntries(request.headers),
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: ['GET', 'HEAD'].includes(request.method) ? '' : await request.text(),
  };
  event.dispatchAnalysis = (id, indexes = null) => {
    const task = analysisBackground({ ...event, body: JSON.stringify({ id, indexes }) });
    context?.waitUntil ? context.waitUntil(task) : task.catch(console.error);
  };
  event.dispatchChat = id => {
    const task = chatBackground({ ...event, body: JSON.stringify({ id }) });
    context?.waitUntil ? context.waitUntil(task) : task.catch(console.error);
  };
  return event;
}

function route(path, method) {
  if (path === '/api/maintenance') return maintenance;
  if (path === '/api/health') return health;
  if (path === '/api/extract') return extract;
  if (path === '/api/chat' && method === 'POST') return chat;
  if (/^\/api\/chat\/jobs\/[^/]+$/.test(path)) return chatJob;
  if (path === '/api/analysis/jobs' && method === 'POST') return analysisStart;
  if (/^\/api\/analysis\/jobs\/[^/]+\/retry\/\d+$/.test(path)) return analysisRetry;
  if (/^\/api\/analysis\/jobs\/[^/]+$/.test(path)) return analysisJob;
  return null;
}

export default {
  async fetch(request, env, context) {
    Object.assign(process.env, env || {});
    const url = new URL(request.url);
    const origin = allowOrigin(request);
    // 브라우저는 본 요청 전에 OPTIONS 로 먼저 물어본다. 여기서 막히면 아무것도 안 된다.
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    const handler = route(url.pathname, request.method);
    if (handler) return response(await handler(await eventOf(request, context)), origin);
    if (env?.ASSETS?.fetch) {
      const local = await env.ASSETS.fetch(request);
      if (local.status !== 404) return local;
    }
    return new Response('Not found', { status: 404 });
  },
};
