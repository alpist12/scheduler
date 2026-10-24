import { analyzeJob, firebaseGet, firebaseSet, pathParts, preflight, publicJob, response } from './_shared.mjs';

export const handler = async event => {
  const pre = preflight(event); if (pre) return pre;
  try {
    const [pathId, pathIndex] = pathParts(event, 'analysis-retry');
    const id = event.queryStringParameters?.id || pathId;
    const index = Number(event.queryStringParameters?.index ?? pathIndex);
    const job = id ? await firebaseGet(`scheduler/AI분석작업/${id}`) : null;
    if (!job || !Number.isInteger(index) || !job.items?.[index]) return response(404, { error: '재시도할 대본 묶음을 찾을 수 없습니다.' }, event);
    job.status = 'queued'; job.items[index].status = 'queued'; job.items[index].error = null; job.updatedAt = new Date().toISOString();
    (job.logs ??= []).push({ time: new Date().toLocaleTimeString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' }), at: job.updatedAt, level: 'info', message: `대본 묶음 ${index + 1} 재분석을 서버에 요청했습니다.` });
    await firebaseSet(`scheduler/AI분석작업/${id}`, job);
    /* 묶음 하나를 이 요청 안에서 끝내고 결과를 돌려준다. 백그라운드로 넘기면
       무료 함수에서는 30초에 잘려 작업이 'running' 인 채로 남는다.
       묶음 하나는 NVIDIA 호출 한 번이라 요청 하나에 들어간다. */
    await analyzeJob(job, [index]);
    return response(200, publicJob(job), event);
  } catch (error) { return response(500, { error: error.message }, event); }
};
