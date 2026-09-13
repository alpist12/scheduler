/** 스케줄러 점검 모드.
 *
 *  상위 사이트의 관리자 콘솔과는 별개다. 상태도 비밀번호도 스케줄러 것만 쓴다.
 *  이 폴더만 배포해도 그대로 동작한다.
 *
 *  비밀번호는 반드시 서버에서만 확인한다. 화면에서 비교하면 개발자 도구로 뚫린다.
 */
import { firebaseGet, firebaseSet } from './_shared.mjs';

const PATH = 'scheduler/점검';
const PASSWORD = String(process.env.SCHEDULER_ADMIN_PASSWORD || '').trim();

const json = (statusCode, value) => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  body: JSON.stringify(value),
});

const now = () => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(new Date());

async function readState() {
  return await firebaseGet(PATH) || {};
}

const publicState = state => ({
  blocked: Boolean(state.blocked),
  message: String(state.message || ''),
  since: String(state.since || ''),
});

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST 요청만 허용됩니다.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: '요청 형식이 올바르지 않습니다.' }); }

  // 상태 조회는 누구나 할 수 있어야 점검 화면을 띄울 수 있다.
  if (body.action === 'status') {
    try { return json(200, { ok: true, ...publicState(await readState()) }); }
    catch (error) { return json(502, { error: error.message }); }
  }

  if (!PASSWORD) return json(503, { error: '서버에 SCHEDULER_ADMIN_PASSWORD 가 설정되지 않았습니다.' });
  // 모바일 키보드가 뒤에 공백을 붙이는 일이 잦다. 그것 때문에 막지는 않는다.
  if (String(body.password || '').trim() !== PASSWORD) return json(401, { error: '비밀번호가 올바르지 않습니다.' });

  try {
    const state = await readState();
    if (body.action === 'verify') return json(200, { ok: true, ...publicState(state) });

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
      return json(200, { ok: true, ...publicState(next) });
    }

    return json(400, { error: '알 수 없는 요청입니다.' });
  } catch (error) {
    return json(502, { error: error.message });
  }
}
