/** 스케줄러 점검 모드.
 *
 *  상위 사이트의 관리자 콘솔과는 별개다. 상태도 비밀번호도 스케줄러 것만 쓴다.
 *  이 폴더만 배포해도 그대로 동작한다.
 *
 *  비밀번호는 반드시 서버에서만 확인한다. 화면에서 비교하면 개발자 도구로 뚫린다.
 */
import { clientIp, firebaseGet, firebaseSet, preflight, response } from './_shared.mjs';

const PATH = 'scheduler/점검';
const password = () => String(process.env.SCHEDULER_ADMIN_PASSWORD || '').trim();
const MAX_FAILURES = 5;
const LOCK_MS = 10 * 60 * 1000;
const attempts = new Map();

const json = (statusCode, value, event) => response(statusCode, value, event);

const now = () => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(new Date());

// 위조 가능한 헤더를 세면 5회 잠금이 의미를 잃는다. _shared 의 판정을 그대로 쓴다.
const clientKey = event => clientIp(event);

function passwordBlocked(event) {
  const item = attempts.get(clientKey(event));
  if (!item) return 0;
  if (Date.now() - item.since >= LOCK_MS) { attempts.delete(clientKey(event)); return 0; }
  return item.count >= MAX_FAILURES ? Math.ceil((LOCK_MS - (Date.now() - item.since)) / 1000) : 0;
}

function recordPasswordResult(event, ok) {
  const key = clientKey(event);
  if (ok) { attempts.delete(key); return; }
  const item = attempts.get(key);
  attempts.set(key, item && Date.now() - item.since < LOCK_MS
    ? { ...item, count: item.count + 1 }
    : { count: 1, since: Date.now() });
  if (attempts.size > 500) {
    for (const [id, value] of attempts) if (Date.now() - value.since >= LOCK_MS) attempts.delete(id);
  }
}

async function readState() {
  return await firebaseGet(PATH) || {};
}

const publicState = state => ({
  blocked: Boolean(state.blocked),
  message: String(state.message || ''),
  since: String(state.since || ''),
});

export async function handler(event) {
  const pre = preflight(event); if (pre) return pre;
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST 요청만 허용됩니다.' }, event);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: '요청 형식이 올바르지 않습니다.' }, event); }

  // 상태 조회는 누구나 할 수 있어야 점검 화면을 띄울 수 있다.
  if (body.action === 'status') {
    try { return json(200, { ok: true, ...publicState(await readState()) }, event); }
    catch (error) { return json(502, { error: error.message }, event); }
  }

  const PASSWORD = password();
  if (!PASSWORD) return json(503, { error: '서버에 SCHEDULER_ADMIN_PASSWORD 가 설정되지 않았습니다.' }, event);
  const retryAfter = passwordBlocked(event);
  if (retryAfter) {
    const base = json(429, { error: '비밀번호를 여러 번 틀렸습니다. 10분 뒤 다시 시도해 주세요.' }, event);
    return { ...base, headers: { ...base.headers, 'retry-after': String(retryAfter) } };
  }
  // 모바일 키보드가 뒤에 공백을 붙이는 일이 잦다. 그것 때문에 막지는 않는다.
  if (String(body.password || '').trim() !== PASSWORD) {
    recordPasswordResult(event, false);
    return json(401, { error: '비밀번호가 올바르지 않습니다.' }, event);
  }
  recordPasswordResult(event, true);

  try {
    const state = await readState();
    if (body.action === 'verify') return json(200, { ok: true, ...publicState(state) }, event);

    if (body.action === 'set') {
      const blocked = Boolean(body.blocked);
      const next = {
        blocked,
        message: String(body.message || '').slice(0, 200),
        since: blocked ? now() : '',
        logs: [
          { time: now(), text: blocked ? '점검 모드 시작' : '점검 모드 해제' },
          ...(Array.isArray(state.logs) ? state.logs : []),
        ].slice(0, 50),
      };
      await firebaseSet(PATH, next);
      return json(200, { ok: true, ...publicState(next) }, event);
    }

    return json(400, { error: '알 수 없는 요청입니다.' }, event);
  } catch (error) {
    return json(502, { error: error.message }, event);
  }
}

/* Netlify의 분산 제한도 함께 둔다. 코드 제한은 실패만 세고, 이 제한은 우회 경로까지 막는다. */
export const config = {
  path: ['/api/maintenance', '/.api/maintenance'],
  rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
