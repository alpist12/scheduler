/* 에어가 직접 부를 수 있는 도구들.
   전부 화면이 보내 준 context 만 읽는다. 서버가 임의로 저장하지 않는다.
   저장·수정·삭제는 '액션'을 만들어 돌려주고, 실제 반영은 화면의 확인 버튼이 한다. */

const DOW = ['월', '화', '수', '목', '금', '토', '일'];
const pad = n => String(n).padStart(2, '0');
const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const cut = (v, max) => String(v ?? '').trim().slice(0, max);

/** 'YYYY-MM-DD' 의 요일. 모델이 세다 틀리는 걸 막으려고 서버가 계산한다. */
function dowOf(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? '' : DOW[(d.getDay() + 6) % 7];
}

function fmtDate(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[(d.getDay() + 6) % 7]})`;
}

/** 화면이 보내 준 주(week) 격자에서 이름별 가능 시간을 읽는다.
 *  availableNames[요일][시간칸] = 그 칸에 가능한 사람 이름들. */
function weekGrid(context) {
  const names = context.availableNames || [];
  const hours = (context.hours || []).map(Number);
  const isos = (context.dateIsos || []).map(x => String(x).slice(0, 10));
  return { names, hours, isos, ok: names.length > 0 && hours.length > 0 && isos.length > 0 };
}

/** 연속된 시간대를 한 줄로 묶는다. 09시,10시,11시 → 09:00~12:00 */
function mergeRuns(slots, hours, isos) {
  const out = [];
  const sorted = [...slots].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [d, hi] of sorted) {
    const last = out.at(-1);
    if (last && last.d === d && last.endIdx === hi) { last.endIdx = hi + 1; continue; }
    out.push({ d, startIdx: hi, endIdx: hi + 1 });
  }
  return out.map(r => ({
    date: isos[r.d] || '',
    label: `${fmtDate(isos[r.d])} ${pad(hours[r.startIdx])}:00~${pad(hours[r.endIdx] ?? hours[r.endIdx - 1] + 1)}:00`,
    startH: hours[r.startIdx],
    endH: hours[r.endIdx] ?? hours[r.endIdx - 1] + 1,
  }));
}

/* ── 조회 도구 ─────────────────────────────────────────── */

function findFreeTime({ names = [], minHours = 1 }, context) {
  const grid = weekGrid(context);
  if (!grid.ok) return { error: '가능 시간 자료가 없습니다. 주간 일정표를 먼저 열어 주세요.' };
  const wanted = names.map(n => cut(n, 40)).filter(Boolean);
  if (!wanted.length) return { error: '누구의 시간을 찾을지 이름이 필요합니다.' };

  const known = new Set(grid.names.flat(2).filter(Boolean));
  const unknown = wanted.filter(n => !known.has(n));

  const hits = [];
  for (let d = 0; d < grid.names.length; d += 1) {
    for (let hi = 0; hi < grid.hours.length; hi += 1) {
      const who = grid.names[d]?.[hi] || [];
      if (wanted.every(n => who.includes(n))) hits.push([d, hi]);
    }
  }
  const runs = mergeRuns(hits, grid.hours, grid.isos)
    .filter(r => (r.endH - r.startH) >= Math.max(1, Number(minHours) || 1));
  return {
    범위: `${grid.isos[0]} ~ ${grid.isos.at(-1)}`,
    대상: wanted,
    이름을_못찾음: unknown.length ? unknown : undefined,
    공통가능: runs.length ? runs.map(r => r.label) : [],
    설명: runs.length ? undefined : '이 주에는 모두 함께 가능한 시간이 없습니다.',
  };
}

function listShoots({ from = '', to = '', person = '', project = '' }, context) {
  const all = (context.shoots || []).filter(Boolean);
  const f = cut(from, 10), t = cut(to, 10);
  const p = cut(person, 40), pj = cut(project, 80);
  const rows = all.filter(s => {
    const date = String(s.date || '').slice(0, 10);
    if (f && date < f) return false;
    if (t && date > t) return false;
    if (p && !(s.cast || []).some(c => (c?.name || '') === p)) return false;
    if (pj && !String(s.title || '').includes(pj)) return false;
    return true;
  }).sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.startH || 0) - (b.startH || 0));
  return {
    건수: rows.length,
    목록: rows.slice(0, 40).map(s => ({
      // 요일까지 서버가 적어 준다. 모델이 세면 틀린다.
      id: s.id, 날짜: `${s.date} (${dowOf(s.date)})`, 시간: `${pad(s.startH)}:00-${pad(s.endH)}:00`,
      제목: s.title, 장소: s.location || '', 출연: (s.cast || []).map(c => c?.name).filter(Boolean),
    })),
    더있음: rows.length > 40 ? rows.length - 40 : undefined,
  };
}

function listMembers({ department = '' }, context) {
  const dept = cut(department, 20);
  const rows = (context.members || []).filter(Boolean)
    .filter(m => !dept || String(m.dept || '').includes(dept));
  return {
    인원수: rows.length,
    목록: rows.map(m => ({ 이름: m.name, 부서: m.dept || '미지정', 이번주_가능시간: m.hours })),
  };
}

function listProjects(_args, context) {
  const list = (context.projects || []).filter(Boolean);
  return { 개수: list.length, 목록: list };
}

/** 오늘 기준 날짜 계산. 모델이 연도를 지어내지 않게 서버가 알려 준다. */
function resolveDates({ expression = '' }, context) {
  const todayIso = String(context.currentDate || '').slice(0, 10)
    || new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
  const today = new Date(`${todayIso}T12:00:00`);
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const plus = n => { const d = new Date(monday); d.setDate(monday.getDate() + n); return isoOf(d); };
  return {
    오늘: todayIso,
    요일: DOW[(today.getDay() + 6) % 7],
    이번주: { 시작: plus(0), 끝: plus(6) },
    다음주: { 시작: plus(7), 끝: plus(13) },
    다다음주: { 시작: plus(14), 끝: plus(20) },
    물어본표현: cut(expression, 60) || undefined,
  };
}

/* ── 저장 도구 (액션만 만든다. 실제 반영은 화면 버튼) ──────── */

const makeAction = value => ({ __action: value });

/** 종료 시각이 없는 씬은 해당 프로젝트의 AI 분석 예상시간을 우선 사용한다. */
function analyzedSceneMinutes(item, context) {
  const title = String(item.title || '');
  const wanted = [...title.matchAll(/S\s*#\s*(\d+)/gi)].map(m => `S#${Number(m[1])}`);
  if (!wanted.length) return 30;
  const projects = (context.projects || []).filter(p => p && typeof p === 'object');
  const named = String(item.projectName || '').trim();
  const project = projects.find(p => named && p.name === named)
    || projects.find(p => p.name && title.includes(p.name));
  const saved = project?.aiAnalysis || {};
  const scenes = saved.job?.scenes || saved.scenes
    || Object.values(saved.analysisJobs || {}).find(job => Array.isArray(job?.scenes))?.scenes || [];
  const minutes = scenes
    .filter(scene => wanted.includes(String(scene?.sceneId || '').replace(/\s+/g, '').toUpperCase()))
    .reduce((sum, scene) => sum + Math.max(0, Number(scene?.estimatedMinutes) || 0), 0);
  return minutes > 0 ? Math.min(480, minutes) : 30;
}

function createShoots({ items = [] }, context) {
  if (!Array.isArray(items) || !items.length) return { error: '등록할 촬영이 없습니다.' };
  /* 사람은 '18시 40분 이후' 처럼 말한다. 끝 시각을 안 주면 씬당 30분으로 잡고,
     30분 단위가 아니면 맞춰 준 뒤 원문을 메모에 남긴다. 그래야 등록이 막히지 않는다. */
  const fixed = items.map(item => {
    const out = { ...item };
    const raw = Number(out.startH);
    if (Number.isFinite(raw)) {
      const snapped = Math.floor(raw * 2) / 2;
      if (snapped !== raw) {
        out.note = [out.note, `요청 시각 ${raw}시`].filter(Boolean).join(' · ');
        out.startH = snapped;
      }
    }
    if (!Number.isFinite(Number(out.endH)) || Number(out.endH) <= Number(out.startH)) {
      const minutes = analyzedSceneMinutes(out, context);
      const duration = Math.max(10, minutes) / 60;
      out.endH = Math.min(24, Number(out.startH) + duration);
      out._defaultDuration = true;
      out._durationHours = duration;
      out.note = [out.note, minutes === 30
        ? '종료 시각이 없어 기본 예상시간 30분을 적용했습니다'
        : `종료 시각이 없어 AI 분석 예상시간 ${minutes}분을 적용했습니다`].filter(Boolean).join(' · ');
    }
    return out;
  });

  /* 같은 날 여러 씬을 몰아 찍는 경우, 모델이 전부 같은 시간으로 잡아 온다.
     같은 사람이 여러 곳에서 동시에 찍을 수는 없으니 그런 씬만 뒤로 민다.
     출연진이 전혀 안 겹치면 두 팀이 동시에 찍을 수 있으므로 그대로 둔다. */
  const byDate = new Map();
  for (const item of fixed) {
    const key = item._defaultDuration
      ? `${item.date}|${item.startH}|AI예상`
      : `${item.date}|${item.startH}|${item.endH}`;
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(item);
  }
  for (const group of byDate.values()) {
    if (group.length < 2) continue;
    const start = Number(group[0].startH), end = Number(group[0].endH);
    const span = end - start;
    if (!(span > 0)) continue;
    /* 사람이 겹치는 씬들끼리 한 덩어리로 묶는다(한 명이라도 같으면 같은 덩어리).
       덩어리 안에서는 순서대로 이어 찍고, 덩어리끼리는 같은 시간에 나란히 찍는다. */
    const names = group.map(x => new Set((x.castNames || []).map(String)));
    const bucket = group.map((_, i) => i);
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        if (![...names[i]].some(n => names[j].has(n))) continue;
        const from = bucket[j], to = bucket[i];
        for (let k = 0; k < bucket.length; k += 1) if (bucket[k] === from) bucket[k] = to;
      }
    }
    for (const id of new Set(bucket)) {
      const chain = group.filter((_, i) => bucket[i] === id);
      if (chain.length < 2) continue;               // 혼자면 원래 구간 그대로
      if (chain.every(item => item._defaultDuration)) {
        let cursor = start;
        chain.forEach((item, i) => {
          item.startH = cursor;
          item.endH = Math.min(24, cursor + Math.max(1 / 6, Number(item._durationHours) || 0.5));
          cursor = item.endH;
          item.note = [item.note, `같은 출연자가 있어 ${chain.length}씬을 AI 예상시간대로 이어 배치했습니다`].filter(Boolean).join(' · ');
        });
        continue;
      }
      const each = Math.max(0.5, Math.floor((span / chain.length) * 2) / 2);
      chain.forEach((item, i) => {
        const from = start + each * i;
        if (from >= end) return;
        item.startH = from;
        item.endH = i === chain.length - 1 ? end : Math.min(end, from + each);
        item.note = [item.note, `같은 출연자가 있어 ${chain.length}씬을 이어서 찍도록 시간을 나눴습니다`].filter(Boolean).join(' · ');
      });
    }
  }
  fixed.forEach(item => { delete item._defaultDuration; delete item._durationHours; });
  return makeAction({ type: 'shoot_schedules', items: fixed });
}
function createPersonal({ items = [] }, _context) {
  if (!Array.isArray(items) || !items.length) return { error: '등록할 개인 일정이 없습니다.' };
  return makeAction({ type: 'personal_schedules', items });
}
function updateShoot({ id = '', item = {} }, _context) {
  if (!id) return { error: '수정할 촬영의 id 가 필요합니다. 먼저 list_shoots 로 찾으세요.' };
  return makeAction({ type: 'shoot_update', id, item });
}
function deleteShoot({ id = '', title = '' }, _context) {
  if (!id) return { error: '삭제할 촬영의 id 가 필요합니다. 먼저 list_shoots 로 찾으세요.' };
  return makeAction({ type: 'shoot_delete', id, title });
}
function deletePersonal({ memberName = '', date = '' }, _context) {
  if (!memberName || !date) return { error: '이름과 날짜가 모두 필요합니다.' };
  return makeAction({ type: 'personal_delete', memberName, date });
}
function createFixedClass(args, _context) {
  return makeAction({ type: 'fixed_class', ...args });
}

/** '이번엔 S#5 빼고 추천해줘'. 씬을 계산에서 빼거나 다시 넣는다.
    뺀 씬은 사라지지 않고 미배정으로 남는다. */
function excludeScenes({ add = [], remove = [], clear = false }, _context) {
  const clean = list => (Array.isArray(list) ? list : []).map(x => cut(x, 60)).filter(Boolean);
  const plus = clean(add), minus = clean(remove);
  if (!clear && !plus.length && !minus.length) return { error: '뺄 씬 번호가 필요합니다. 예: S#5' };
  return makeAction({ type: 'plan_exclude_scenes', add: plus, remove: minus, clear: !!clear });
}


const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** 그 사람의 개인 일정과 매주 반복 수업을 읽는다.
    도구로 바꾸면서 사라졌던 '철수 이번 주 일정 알려줘' 를 되살린다. */
function getMemberSchedule({ name = '' }, context) {
  const who = cut(name, 40);
  const member = (context.members || []).find(m => (m?.name || '') === who);
  if (!member) {
    const all = (context.members || []).map(m => m?.name).filter(Boolean);
    return { error: `${who || '그 사람'}을 등록 인원에서 찾지 못했습니다.`, 등록된_인원: all };
  }
  const fixed = [];
  for (const [i, key] of DAY_KEYS.entries()) {
    for (const item of (member.fixedSchedule?.[key] || [])) {
      fixed.push({ 요일: `${DOW[i]}요일`, 시간: `${pad(item.start)}:00~${pad(item.end)}:00`, 내용: item.label || '수업' });
    }
  }
  const personal = [];
  for (const [day, entry] of Object.entries(member.schedules || {})) {
    const ranges = [
      ...(entry?.availableRanges || []).map(r => ({ ...r, 상태: '가능' })),
      ...(entry?.unavailableRanges || []).map(r => ({ ...r, 상태: '불가능' })),
      ...((entry?.ranges || []).map(r => ({ ...r, 상태: entry?.status || '가능' }))),
    ];
    for (const r of ranges) personal.push({ 날짜: day, 시간: `${pad(r.start)}:00~${pad(r.end)}:00`, 상태: r.상태 });
  }
  const shoots = (context.shoots || []).filter(s => (s.cast || []).some(c => (c?.name || '') === who))
    .map(s => ({ 날짜: `${s.date} (${dowOf(s.date)})`, 시간: `${pad(s.startH)}:00-${pad(s.endH)}:00`, 제목: s.title }));
  return {
    이름: who, 부서: member.dept || member.department || '미지정',
    이번주_가능시간: member.hours != null ? `${member.hours}시간` : undefined,
    매주_반복: fixed.length ? fixed : '없음',
    개인일정: personal.length ? personal : '없음',
    촬영: shoots.length ? shoots : '없음',
  };
}

/** 같은 사람이 같은 시간에 두 촬영에 잡혀 있는지 훑는다. 시간만 겹치는 건 문제가 아니다. */
function findConflicts({ from = '', to = '' }, context) {
  const list = (context.shoots || []).filter(Boolean)
    .filter(s => (!from || String(s.date) >= from) && (!to || String(s.date) <= to));
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i], b = list[j];
      if (a.date !== b.date) continue;
      if (!(+a.startH < +b.endH && +b.startH < +a.endH)) continue;
      const ids = new Set((a.cast || []).map(c => c?.name).filter(Boolean));
      const both = (b.cast || []).map(c => c?.name).filter(n => ids.has(n));
      if (!both.length) continue;
      out.push({ 날짜: `${a.date} (${dowOf(a.date)})`,
        촬영1: `${a.title} (${pad(a.startH)}:00-${pad(a.endH)}:00)`,
        촬영2: `${b.title} (${pad(b.startH)}:00-${pad(b.endH)}:00)`,
        겹치는인원: both });
    }
  }
  return out.length ? { 충돌: out.length, 목록: out.slice(0, 20) } : { 충돌: 0, 설명: '같은 사람이 겹치는 촬영은 없습니다.' };
}

/** 기간 통계. 몇 건, 몇 시간, 어디서, 누가 많이 나오는지. */
function summarizeShoots({ from = '', to = '' }, context) {
  const list = (context.shoots || []).filter(Boolean)
    .filter(s => (!from || String(s.date) >= from) && (!to || String(s.date) <= to));
  if (!list.length) return { 건수: 0, 설명: '해당 기간에 등록된 촬영이 없습니다.' };
  const hours = list.reduce((n, s) => n + Math.max(0, (+s.endH || 0) - (+s.startH || 0)), 0);
  const places = [...new Set(list.map(s => s.location).filter(Boolean))];
  const count = new Map();
  for (const s of list) for (const c of (s.cast || [])) if (c?.name) count.set(c.name, (count.get(c.name) || 0) + 1);
  const top = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n} ${c}건`);
  const days = [...new Set(list.map(s => s.date))].sort();
  return { 건수: list.length, 총시간: `${hours}시간`, 촬영일수: days.length,
    기간: `${days[0]} ~ ${days.at(-1)}`, 장소: places.length ? places : '미지정',
    많이_나오는_인원: top };
}

/** 특정 날짜·시각에 되는 사람을 뽑는다. 화면이 보고 있는 주만 계산할 수 있다. */
function whoIsFree({ date = '', hour = 0 }, context) {
  const grid = weekGrid(context);
  if (!grid.ok) return { error: '가능 시간 자료가 없습니다. 주간 일정표를 먼저 열어 주세요.' };
  const d = grid.isos.indexOf(cut(date, 10));
  if (d < 0) return { error: `${date} 는 지금 보고 있는 주(${grid.isos[0]} ~ ${grid.isos.at(-1)}) 안에 없습니다.` };
  const hi = grid.hours.indexOf(Number(hour));
  if (hi < 0) return { error: `${hour}시는 계산 범위(${grid.hours[0]}시~${grid.hours.at(-1)}시) 밖입니다.` };
  const yes = grid.names[d]?.[hi] || [];
  const all = (context.members || []).map(m => m?.name).filter(Boolean);
  return { 날짜: `${date} (${dowOf(date)})`, 시각: `${pad(hour)}:00`, 가능: yes, 불가능: all.filter(n => !yes.includes(n)) };
}

/** 기존 촬영의 출연진만 바꾼다. 전체 항목을 다시 적지 않아도 되게 한다. */
function editCast({ id = '', add = [], remove = [] }, context) {
  const target = (context.shoots || []).find(s => String(s.id) === String(id));
  if (!target) return { error: '그 id 의 촬영을 찾지 못했습니다. list_shoots 로 먼저 확인하세요.' };
  const names = new Set((target.cast || []).map(c => c?.name).filter(Boolean));
  for (const n of (Array.isArray(add) ? add : [])) if (n) names.add(cut(n, 40));
  for (const n of (Array.isArray(remove) ? remove : [])) names.delete(cut(n, 40));
  return makeAction({ type: 'shoot_update', id: target.id, item: {
    title: target.title, date: target.date, startH: target.startH, endH: target.endH,
    location: target.location || '', projectName: target.projectName || '',
    castNames: [...names],
  } });
}

/* ── 스키마 ────────────────────────────────────────────── */

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const arr = (description, items) => ({ type: 'array', description, items });

export const TOOL_IMPL = {
  resolve_dates: resolveDates,
  find_free_time: findFreeTime,
  list_shoots: listShoots,
  list_members: listMembers,
  list_projects: listProjects,
  create_shoots: createShoots,
  create_personal_schedules: createPersonal,
  update_shoot: updateShoot,
  delete_shoot: deleteShoot,
  delete_personal_schedule: deletePersonal,
  create_fixed_class: createFixedClass,
  get_member_schedule: getMemberSchedule,
  find_conflicts: findConflicts,
  summarize_shoots: summarizeShoots,
  who_is_free: whoIsFree,
  edit_shoot_cast: editCast,
  exclude_scenes: excludeScenes,
};

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'resolve_dates',
      description: '오늘 날짜와 이번주/다음주의 정확한 날짜 범위를 알려준다. 날짜가 들어간 질문이면 반드시 먼저 호출한다. 연도나 날짜를 추측하지 말 것.',
      parameters: { type: 'object', properties: { expression: str('사용자가 말한 날짜 표현. 예: 다음 주, 이번 주말') }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_free_time',
      description: '여러 사람이 모두 가능한 시간대를 찾는다. 화면이 보고 있는 주(週)만 계산할 수 있다.',
      parameters: {
        type: 'object',
        properties: {
          names: arr('인원 이름 목록', { type: 'string' }),
          minHours: { type: 'integer', description: '최소 연속 시간(시간 단위). 기본 1' },
        },
        required: ['names'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_shoots',
      description: '등록된 촬영 일정을 조회한다. 수정·삭제 전에 id 를 찾을 때도 쓴다.',
      parameters: {
        type: 'object',
        properties: {
          from: str('시작 날짜 YYYY-MM-DD'), to: str('끝 날짜 YYYY-MM-DD'),
          person: str('이 사람이 출연하는 촬영만'), project: str('제목에 이 말이 들어간 촬영만'),
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_members',
      description: '등록된 인원을 조회한다.',
      parameters: { type: 'object', properties: { department: str('부서로 거르기. 예: 기획, 아나운서, 기술') }, required: [] },
    },
  },
  {
    type: 'function',
    function: { name: 'list_projects', description: '등록된 프로젝트(기획) 목록을 조회한다.', parameters: { type: 'object', properties: {}, required: [] } },
  },
  {
    type: 'function',
    function: {
      name: 'create_shoots',
      description: '촬영 일정을 만든다. 실제 저장은 사용자가 버튼을 눌러야 일어난다.',
      parameters: {
        type: 'object',
        properties: {
          items: arr('촬영 목록', {
            type: 'object',
            properties: {
              title: str('촬영 제목. 예: 5화 3씬'), date: str('YYYY-MM-DD'),
              startH: { type: 'number', description: '시작 시각(0-24). 18시 30분은 18.5' },
              endH: { type: 'number', description: '종료 시각(0-24). 사용자가 종료 시각을 말하지 않으면 생략' },
              location: str('장소'), projectName: str('기획 이름'),
              castNames: arr('출연 인원 이름', { type: 'string' }),
            },
            required: ['title', 'date', 'startH'],
          }),
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_personal_schedules',
      description: '개인 일정(가능/불가능)을 등록한다. 하루는 9시~23시로 본다. 실제 저장은 사용자가 버튼을 눌러야 한다.',
      parameters: {
        type: 'object',
        properties: {
          items: arr('개인 일정 목록', {
            type: 'object',
            properties: {
              memberName: str('인원 이름'), date: str('YYYY-MM-DD'),
              status: str('가능 또는 불가능'),
              start: { type: 'integer', description: '시작 시각' },
              end: { type: 'integer', description: '종료 시각' },
              memo: str('괄호 안 설명 등'),
            },
            required: ['memberName', 'date', 'status', 'start', 'end'],
          }),
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_shoot',
      description: '기존 촬영 일정을 수정한다. id 는 list_shoots 로 먼저 찾는다. 바뀌지 않는 값도 모두 넣는다.',
      parameters: {
        type: 'object',
        properties: {
          id: str('촬영 id'),
          item: {
            type: 'object',
            properties: {
              title: str('제목'), date: str('YYYY-MM-DD'),
              startH: { type: 'integer' }, endH: { type: 'integer' },
              location: str('장소'), projectName: str('기획'), castNames: arr('출연', { type: 'string' }),
            },
            required: ['title', 'date', 'startH', 'endH'],
          },
        },
        required: ['id', 'item'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_shoot',
      description: '촬영 일정을 삭제한다. id 는 list_shoots 로 먼저 찾는다.',
      parameters: { type: 'object', properties: { id: str('촬영 id'), title: str('확인용 제목') }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_personal_schedule',
      description: '어떤 사람의 하루 개인 일정을 통째로 지운다.',
      parameters: { type: 'object', properties: { memberName: str('이름'), date: str('YYYY-MM-DD') }, required: ['memberName', 'date'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_fixed_class',
      description: '매주 반복되는 수업·회의를 등록한다. 요일은 0=월 ~ 6=일.',
      parameters: {
        type: 'object',
        properties: {
          memberName: str('이름'), title: str('수업/회의 이름'),
          day: { type: 'integer', description: '0=월 ~ 6=일' },
          start: { type: 'integer' }, end: { type: 'integer' },
        },
        required: ['memberName', 'title', 'day', 'start', 'end'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_member_schedule',
      description: '한 사람의 개인 일정·매주 반복 수업·출연 촬영을 한 번에 본다. "철수 이번 주 일정 알려줘" 같은 질문에 쓴다.',
      parameters: { type: 'object', properties: { name: str('인원 이름') }, required: ['name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_conflicts',
      description: '같은 사람이 같은 시간에 두 촬영에 잡혀 있는지 찾는다. 시간만 겹치는 것은 충돌이 아니다.',
      parameters: { type: 'object', properties: { from: str('시작 YYYY-MM-DD'), to: str('끝 YYYY-MM-DD') }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'summarize_shoots',
      description: '기간별 촬영 통계. 건수, 총 시간, 촬영일수, 장소, 많이 나오는 인원.',
      parameters: { type: 'object', properties: { from: str('시작 YYYY-MM-DD'), to: str('끝 YYYY-MM-DD') }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'who_is_free',
      description: '특정 날짜·시각에 가능한 사람과 불가능한 사람을 알려준다. 화면이 보고 있는 주만 계산할 수 있다.',
      parameters: {
        type: 'object',
        properties: { date: str('YYYY-MM-DD'), hour: { type: 'integer', description: '시각(9~23)' } },
        required: ['date', 'hour'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'exclude_scenes',
      description: "특정 씬을 이번 촬영안 계산에서 빼거나 다시 넣는다. '5씬 빼고 추천해줘' 같은 요청에 쓴다. 뺀 씬은 사라지지 않고 미배정으로 남는다.",
      parameters: {
        type: 'object',
        properties: {
          add: arr('뺄 씬 번호. 예: ["S#5"]', { type: 'string' }),
          remove: arr('다시 넣을 씬 번호', { type: 'string' }),
          clear: { type: 'boolean', description: '제외를 전부 해제하려면 true' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_shoot_cast',
      description: '기존 촬영의 출연진만 더하거나 뺀다. id 는 list_shoots 로 먼저 찾는다. 실제 반영은 사용자가 버튼을 눌러야 한다.',
      parameters: {
        type: 'object',
        properties: { id: str('촬영 id'), add: arr('추가할 이름', { type: 'string' }), remove: arr('뺄 이름', { type: 'string' }) },
        required: ['id'],
      },
    },
  },
];

/** 도구 하나를 실행한다. 결과는 모델에게 돌려줄 JSON. */
export function runTool(name, args, context) {
  const fn = TOOL_IMPL[name];
  if (!fn) return { error: `${name} 이라는 도구는 없습니다.` };
  try {
    return fn(args && typeof args === 'object' ? args : {}, context || {});
  } catch (error) {
    return { error: `도구 실행 실패: ${error.message}` };
  }
}
