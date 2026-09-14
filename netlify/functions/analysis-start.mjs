import crypto from 'node:crypto';
import { dispatchAnalysis, firebaseGet, firebasePatch, firebaseSet, parseBody, precisionOf, publicJob, response, splitScenes } from './_shared.mjs';

export const handler = async event => {
  try {
    const body = parseBody(event);
    const precision = String(body.precision || '균형 (추천)');
    if (body.projectId && !await firebaseGet(`scheduler/프로젝트/${body.projectId}`)) return response(404, { error: '프로젝트를 찾을 수 없습니다.' });
    if (body.projectId && (!body.crew?.planning?.length || !body.crew?.production?.length)) return response(400, { error: '프로젝트의 기획·촬영/편집 담당을 모두 지정한 뒤 분석해 주세요.' });
    /* 작업 문서 하나에 원문(sourceChunks)과 분석 결과가 같이 들어간다.
       Firestore 문서 한도는 1MiB 라, 넘기면 저장이 조용히 실패하고 화면은
       진행률 0% 에서 영원히 멈춘다. 들어오기 전에 막고 이유를 알려 준다. */
    const bytes = Buffer.byteLength(String(body.text || ''), 'utf8');
    const LIMIT = 500 * 1024;
    if (bytes > LIMIT) return response(413, { error: `대본이 너무 깁니다 (${Math.round(bytes / 1024)}KB). `
      + `${Math.round(LIMIT / 1024)}KB 이하로 나눠서 올려 주세요.` });
    const chunks = splitScenes(body.text, precisionOf(precision).maxChars);
    if (!chunks.length) return response(400, { error: '분석할 대본 텍스트가 없습니다.' });
    if (!process.env.NVIDIA_API_KEY) return response(503, { error: 'Netlify 환경변수 NVIDIA_API_KEY가 설정되지 않았습니다.' });
    const id = crypto.randomUUID(), now = new Date().toISOString();
    const job = { id, precision, crew: body.crew || null, filename: String(body.filename || '대본'), projectId: body.projectId || null, status: 'queued', progress: 0, createdAt: now, updatedAt: now, sourceChunks: chunks, items: chunks.map((_, index) => ({ index, status: 'queued', scenes: [], error: null })), scenes: [], logs: [{ time: new Date().toLocaleTimeString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' }), level: 'info', message: `텍스트 추출 완료 · ${chunks.length}개 분석 묶음 · 정밀도 ${precision}` }] };
    await firebaseSet(`scheduler/AI분석작업/${id}`, job);
    if (job.projectId) await firebasePatch(`scheduler/프로젝트/${job.projectId}/aiAnalysis`, {
      activeJobId: id, job: publicJob(job), [`analysisJobs/${id}`]: publicJob(job),
      script: { filename: job.filename, text: String(body.text), characters: String(body.text).length, textStored: true },
    });
    await dispatchAnalysis(event, id);
    return response(202, publicJob(job));
  } catch (error) { return response(500, { error: error.message }); }
};
