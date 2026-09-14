import { analyzeJob, firebaseGet, firebaseSet } from './_shared.mjs';

const now = () => new Date().toLocaleTimeString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' });

export const handler = async event => {
  const body = JSON.parse(event.body || '{}');
  if (!body.id) throw new Error('작업 ID가 없습니다.');
  const job = await firebaseGet(`scheduler/AI분석작업/${body.id}`);
  if (!job) throw new Error('분석 작업을 찾을 수 없습니다.');
  job.logs ||= [];
  job.logs.push({ time: now(), level: 'info', message: '백그라운드 서버가 분석 작업을 시작했습니다.' });
  try {
    await analyzeJob(job, Array.isArray(body.indexes) ? body.indexes : null);
  } catch (error) {
    /* 여기서 그냥 던지면 작업은 'running' 인 채로 남고 화면은 끝나지 않는 분석을
       계속 기다린다. 실패했다는 사실만이라도 남긴다. */
    job.status = 'failed';
    job.updatedAt = new Date().toISOString();
    job.logs.push({ time: now(), level: 'error', message: `분석이 중단되었습니다 · ${error.message}` });
    try { await firebaseSet(`scheduler/AI분석작업/${job.id}`, job); } catch { /* 이것마저 실패하면 손쓸 수 없다 */ }
    throw error;
  }
};
