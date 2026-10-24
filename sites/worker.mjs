import { handler as maintenance } from '../api/maintenance.mjs';
import { handler as health } from '../api/health.mjs';
import { handler as chat } from '../api/chat.mjs';
import { handler as chatJob } from '../api/chat-job.mjs';
import { handler as chatBackground } from '../api/chat-run-background.mjs';
import { handler as analysisStart } from '../api/analysis-start.mjs';
import { handler as analysisJob } from '../api/analysis-job.mjs';
import { handler as analysisRetry } from '../api/analysis-retry.mjs';
import { handler as analysisBackground } from '../api/analysis-run-background.mjs';

/* CORS 는 핸들러(api/_shared.mjs)가 붙인다. Netlify 는 worker 를 거치지 않고
   핸들러를 바로 부르므로, 양쪽에서 같게 동작하려면 그쪽 한 곳이어야 한다. */

function response(result) {
  const status = result?.statusCode || 200;
  // 204/304 는 본문을 가질 수 없다. 빈 문자열도 거부당한다.
  const body = status === 204 || status === 304 ? null : (result?.body || '');
  return new Response(body, {
    status,
    headers: result?.headers || { 'content-type': 'application/json; charset=utf-8' },
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
  /* preflight(OPTIONS)는 본 요청과 같은 경로로 보낸다. 메서드로만 걸러내면
     라우트를 못 찾아 404 가 되고, 브라우저는 본 요청을 아예 보내지 않는다. */
  if (method === 'OPTIONS') method = 'POST';
  if (path === '/api/maintenance') return maintenance;
  if (path === '/api/health') return health;
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
    const handler = route(url.pathname, request.method);
    if (handler) return response(await handler(await eventOf(request, context)));
    if (env?.ASSETS?.fetch) {
      const local = await env.ASSETS.fetch(request);
      if (local.status !== 404) return local;
    }
    return new Response('Not found', { status: 404 });
  },
};
