import { firebaseGet, pathParts, preflight, publicJob, response } from './_shared.mjs';

export const handler = async event => {
  const pre = preflight(event); if (pre) return pre;
  try {
    const id = event.queryStringParameters?.id || pathParts(event, 'analysis-job')[0];
    if (!id) return response(400, { error: '작업 ID가 없습니다.' }, event);
    const job = await firebaseGet(`scheduler/AI분석작업/${id}`);
    return job ? response(200, publicJob(job), event) : response(404, { error: '작업을 찾을 수 없습니다.' }, event);
  } catch (error) { return response(500, { error: error.message }, event); }
};
