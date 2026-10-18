import { firebaseGet, pathParts, publicJob, response } from './_shared.mjs';

export const handler = async event => {
  try {
    const id = event.queryStringParameters?.id || pathParts(event, 'analysis-job')[0];
    if (!id) return response(400, { error: '작업 ID가 없습니다.' });
    const job = await firebaseGet(`scheduler/AI분석작업/${id}`);
    return job ? response(200, publicJob(job)) : response(404, { error: '작업을 찾을 수 없습니다.' });
  } catch (error) { return response(500, { error: error.message }); }
};
