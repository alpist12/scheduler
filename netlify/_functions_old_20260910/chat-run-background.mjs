import { firebaseGet, firebaseSet } from './_shared.mjs';
import { runChat } from './chat.mjs';

export const handler = async event => {
  const { id } = JSON.parse(event.body || '{}');
  if (!id) throw new Error('작업 ID가 없습니다.');
  const job = await firebaseGet(`scheduler/AI채팅작업/${id}`);
  if (!job) throw new Error('채팅 작업을 찾을 수 없습니다.');
  await firebaseSet(`scheduler/AI채팅작업/${id}`, { ...job, status: 'running' });
  // 백그라운드 함수는 15분까지 살아 있으므로 시간 제한을 걸지 않는다.
  const result = await runChat({ message: job.message, context: job.context || {}, timeoutMs: 120000 });
  const body = JSON.parse(result.body);
  await firebaseSet(`scheduler/AI채팅작업/${id}`, {
    ...job,
    status: result.statusCode === 200 ? 'completed' : 'failed',
    finishedAt: new Date().toISOString(),
    result: body,
    context: null,
  });
};
