/* 에어 도구 루프를 실제 NIM 으로 돌려 본다. 망이 필요해 기본 테스트에는 넣지 않는다.
   사용: node tools/air_agent_probe.mjs "질문" ["질문2" ...] */
import fs from 'node:fs';

for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const s = line.trim();
  if (!s || s.startsWith('#') || !s.includes('=')) continue;
  const [k, v] = s.split(/=(.*)/s);
  process.env[k.trim()] = v.trim();
}
const { runChat } = await import('../api/chat.mjs');

const hours = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
const dateIsos = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'];
const trio = ['강주형', '이서연', '서창민'];
const availableNames = dateIsos.map((_, d) => hours.map(h => (d === 3 && (h === 18 || h === 19)) ? trio : (h === 14 ? ['강주형'] : [])));
const context = {
  currentDate: '2026-09-13', currentHour: 15, hours, dateIsos, availableNames,
  availability: availableNames.map(col => col.map(x => x.length)),
  dates: ['9월 14일 (월)', '9월 15일 (화)', '9월 16일 (수)', '9월 17일 (목)', '9월 18일 (금)', '9월 19일 (토)', '9월 20일 (일)'],
  // 실제 데이터와 같은 모양: 매주 수업 + 옛 형식(ranges+status) 개인 일정
  members: trio.map((name, i) => ({
    id: String(i), name, dept: '아나운서부', hours: 10,
    fixedSchedule: i === 0 ? { mon: [{ start: 9, end: 12, label: '전공수업' }] } : {},
    schedules: i === 0 ? { '2026-09-15': { status: '불가능', ranges: [{ start: 18, end: 23 }] } } : {},
  })),
  projects: ['1화', '3화', '5화'],
  shoots: [
    { id: 'a1', date: '2026-09-14', startH: 18, endH: 19, title: '1화 S#1', location: '분수대', cast: [{ name: '강주형' }] },
    { id: 'a2', date: '2026-09-17', startH: 18, endH: 23, title: '1화 S#3', location: '', cast: [{ name: '이서연' }] },
  ],
};

// 동기 경로(timeoutMs>0)가 실제 서비스와 같은 조건이다.
for (const message of process.argv.slice(2)) {
  const res = await runChat({ message, context, history: [], timeoutMs: Number(process.env.AIR_TIMEOUT || 9000) });
  const body = JSON.parse(res.body);
  console.log('='.repeat(68));
  console.log('[나]   ' + message);
  console.log('[도구] ' + ((body.tools || []).join(' → ') || '(없음)'));
  console.log('[에어] ' + (body.reply || body.error || '(빈 응답)').slice(0, 500));
  if (body.action) console.log('[액션] ' + JSON.stringify(body.action).slice(0, 260));
  console.log('[시간] ' + JSON.stringify(body.timing || {}));
  // 도구를 썼는데 문장이 비면 그게 사고다.
  if ((body.tools || []).length && /답변을 정리하지 못했어요/.test(body.reply || '')) {
    console.log('!! 도구를 쓰고도 문장을 못 만들었습니다');
    process.exitCode = 1;
  }
}
