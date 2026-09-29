import { handler as maintenance } from '../netlify/functions/maintenance.mjs';
import { handler as health } from '../netlify/functions/health.mjs';
import { handler as extract } from '../netlify/functions/extract.mjs';
import { handler as chat } from '../netlify/functions/chat.mjs';
import { handler as chatJob } from '../netlify/functions/chat-job.mjs';
import { handler as chatBackground } from '../netlify/functions/chat-run-background.mjs';
import { handler as analysisStart } from '../netlify/functions/analysis-start.mjs';
import { handler as analysisJob } from '../netlify/functions/analysis-job.mjs';
import { handler as analysisRetry } from '../netlify/functions/analysis-retry.mjs';
import { handler as analysisBackground } from '../netlify/functions/analysis-run-background.mjs';

function response(result) {
  return new Response(result?.body || '', {
    status: result?.statusCode || 200,
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
    const handler = route(url.pathname, request.method);
    if (handler) return response(await handler(await eventOf(request, context)));
    if (env?.ASSETS?.fetch) {
      const local = await env.ASSETS.fetch(request);
      if (local.status !== 404) return local;
    }
    return new Response('Not found', { status: 404 });
  },
};
