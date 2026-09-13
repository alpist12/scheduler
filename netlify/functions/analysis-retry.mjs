import { dispatchAnalysis, firebaseGet, firebaseSet, pathParts, publicJob, response } from './_shared.mjs';

export const handler = async event => {
  try {
    const [pathId, pathIndex] = pathParts(event, 'analysis-retry');
    const id = event.queryStringParameters?.id || pathId;
    const index = Number(event.queryStringParameters?.index ?? pathIndex);
    const job = id ? await firebaseGet(`scheduler/AI분석작업/${id}`) : null;
    if (!job || !Number.isInteger(index) || !job.items?.[index]) return response(404, { error: '재시도할 대본 묶음을 찾을 수 없습니다.' });
    job.status = 'queued'; job.items[index].status = 'queued'; job.items[index].error = null; job.updatedAt = new Date().toISOString();
    (job.logs ??= []).push({ time: new Date().toLocaleTimeString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' }), at: job.updatedAt, level: 'info', message: `대본 묶음 ${index + 1} 재분석을 서버에 요청했습니다.` });
    await firebaseSet(`scheduler/AI분석작업/${id}`, job);
    await dispatchAnalysis(event, id, [index]);
    return response(202, publicJob(job));
  } catch (error) { return response(500, { error: error.message }); }
};
