import { analyzeJob, firebaseGet } from './_shared.mjs';

export const handler = async event => {
  const body = JSON.parse(event.body || '{}');
  if (!body.id) throw new Error('작업 ID가 없습니다.');
  const job = await firebaseGet(`scheduler/AI분석작업/${body.id}`);
  if (!job) throw new Error('분석 작업을 찾을 수 없습니다.');
  job.logs ||= [];
  job.logs.push({ time: new Date().toLocaleTimeString('ko-KR', { hour12:false, timeZone:'Asia/Seoul' }), level:'info', message:'백그라운드 서버가 분석 작업을 시작했습니다.' });
  await analyzeJob(job, Array.isArray(body.indexes) ? body.indexes : null);
};
