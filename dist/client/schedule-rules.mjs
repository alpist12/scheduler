export function sceneMinutes(scene = {}) {
  const minutes = Number(scene.estimatedMinutes);
  return minutes > 0 ? minutes : 30;
}

export function hourText(value) {
  const total = Math.round(Number(value) * 60);
  const hour = Math.floor(total / 60);
  const minute = ((total % 60) + 60) % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

const genericLocationWords = new Set(['내부', '외부', '실내', '실외', '복도', '교실', '강의실', '외관', '장면', '일부분']);

export function locationWords(scene = {}) {
  return new Set(String(scene.location || '')
    .toLocaleLowerCase('ko')
    .match(/[a-z]+\d*동?|[가-힣]+|\d+/g)
    ?.filter(word => word.length > 1 && !genericLocationWords.has(word)) || []);
}

export function locationAffinity(a, b) {
  const left = locationWords(a), right = locationWords(b);
  return [...left].filter(word => right.has(word)).length;
}

/** 30분 눈금에 실제 가능 시작/종료 경계를 더한다. 18:35, 18:40도 후보가 된다. */
export function candidateStarts({ totalHours, windows = [], dayStart = 9, dayEnd = 23 }) {
  const starts = new Set();
  for (let minute = dayStart * 60; minute + totalHours * 60 <= dayEnd * 60; minute += 30) starts.add(minute);
  for (const window of windows) for (const range of (window.ranges || [])) {
    starts.add(Math.round((Number(range.start) - Number(window.from || 0)) * 60));
    starts.add(Math.round((Number(range.end) - Number(window.to || 0)) * 60));
  }
  return [...starts]
    .filter(minute => minute >= dayStart * 60 && minute + totalHours * 60 <= dayEnd * 60)
    .sort((a, b) => a - b)
    .map(minute => minute / 60);
}

export function continuityScore({ date, start, end, requiredIds = [], shoots = [], memberIdsOfShoot }) {
  const required = new Set(requiredIds);
  let best = { score: 0, label: '' };
  for (const shoot of shoots) {
    if (!shoot || shoot.date !== date) continue;
    const afterGap = start - Number(shoot.endH);
    const beforeGap = Number(shoot.startH) - end;
    const gap = afterGap >= 0 ? afterGap : beforeGap >= 0 ? beforeGap : Infinity;
    if (gap > 1) continue;
    const overlap = [...(memberIdsOfShoot(shoot) || [])].filter(id => required.has(id));
    if (!overlap.length) continue;
    const score = overlap.length * (gap < 1 / 120 ? 3 : gap <= .5 ? 2 : 1);
    const direction = afterGap >= 0 ? '이후' : '이전';
    if (score > best.score) best = { score, label: `${shoot.title || '기존 촬영'} ${direction} 연속 촬영 · 겹치는 인원 ${overlap.length}명` };
  }
  return best;
}
