import { firebaseGet, firebaseSet } from './_shared.mjs';
import { runChat } from './chat.mjs';

export const handler = async event => {
  const { id } = JSON.parse(event.body || '{}');
  if (!id) throw new Error('작업 ID가 없습니다.');
  const job = await firebaseGet(`scheduler/AI채팅작업/${id}`);
  if (!job) throw new Error('채팅 작업을 찾을 수 없습니다.');
  await firebaseSet(`scheduler/AI채팅작업/${id}`, { ...job, status: 'running' });
  // 백그라운드 함수는 15분까지 살아 있으므로 넉넉히 준다.
  let status = 'failed';
  let body = { error: '알 수 없는 오류로 답변을 만들지 못했습니다.' };
  try {
    const result = await runChat({ message: job.message, context: job.context || {}, history: job.history || [], timeoutMs: 120000 });
    body = JSON.parse(result.body);
    status = result.statusCode === 200 ? 'completed' : 'failed';
  } catch (error) {
    /* 여기서 던지면 작업이 'running' 인 채로 남아 화면이 3분을 기다리다 만다.
       실패로 닫아 주고 이유를 남긴다. */
    body = { error: `백그라운드 처리 중 오류: ${error.message || error}` };
  }
  await firebaseSet(`scheduler/AI채팅작업/${id}`, {
    ...job, status,
    finishedAt: new Date().toISOString(),
    result: body,
    context: null,
  });
};
