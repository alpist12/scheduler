import { firebaseGet, pathParts, preflight, response } from './_shared.mjs';

export const handler = async event => {
  const pre = preflight(event); if (pre) return pre;
  try {
    // 리다이렉트를 거치면 함수 이름이 경로에 남지 않으므로 ?id= 를 우선 본다.
    const id = String(event.queryStringParameters?.id || '').trim() || pathParts(event, 'chat-job')[0];
    if (!id) return response(400, { error: '작업 ID가 없습니다.' }, event);
    const job = await firebaseGet(`scheduler/AI채팅작업/${id}`);
    if (!job) return response(404, { error: '채팅 작업을 찾을 수 없습니다.' }, event);
    return response(200, { id, status: job.status, ...(job.result || {}, event) });
  } catch (error) { return response(500, { error: error.message }, event); }
};
