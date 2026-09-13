import { analyzeJob, firebaseGet, pathParts, publicJob, response } from './_shared.mjs';

export const handler = async event => {
  try {
    const [pathId, pathIndex] = pathParts(event, 'analysis-retry');
    const id = event.queryStringParameters?.id || pathId;
    const index = Number(event.queryStringParameters?.index ?? pathIndex);
    const job = id ? await firebaseGet(`scheduler/AI분석작업/${id}`) : null;
    if (!job || !Number.isInteger(index) || !job.items?.[index]) return response(404, { error: '재시도할 대본 묶음을 찾을 수 없습니다.' });
    job.items[index].status = 'queued'; job.items[index].error = null;
    return response(200, publicJob(await analyzeJob(job, [index])));
  } catch (error) { return response(500, { error: error.message }); }
};
