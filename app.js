import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js';
import {
  getFirestore, doc, collection, collectionGroup, onSnapshot,
  setDoc, deleteDoc, getDocs, query, where, writeBatch,
} from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js';
import { candidateStarts, continuityScore, hourText, locationAffinity, sceneMinutes } from './schedule-rules.mjs';

const app = initializeApp({
  apiKey: 'AIzaSyDXmeiQpRSZshFA1_BgZ2z_8AKLy6_Nc8M',
  authDomain: 'hnubs-2sceduler.firebaseapp.com',
  // Realtime Database 는 더 이상 쓰지 않는다. 데이터는 전부 Firestore 에 있다.
  projectId: 'hnubs-2sceduler',
  storageBucket: 'hnubs-2sceduler.firebasestorage.app',
  messagingSenderId: '955574947722',
  appId: '1:955574947722:web:50d14833ae966ea0698273',
});
// 콘솔에서 만든 데이터베이스 ID 가 '(default)' 가 아니라 'default' 다. 한 곳에서만 바꾸면 되게 상수로 둔다.
const FIRESTORE_DB = 'default';
const db = getFirestore(app, FIRESTORE_DB);

/* RTDB 시절의 ref/set/remove 자리를 그대로 쓰기 위한 얇은 껍데기.
   경로는 'members/abc/availability/2026-09-10' 처럼 슬래시로 쓴다. */
const docRef = path => doc(db, path);
/* 화면(디자인 프레임)에서 넘어온 값은 다른 프레임 소속이라
   Firestore 가 '일반 객체가 아니다'라며 거부한다. 쓰기 직전에 평범한 값으로 되돌린다. */
const plain = value => JSON.parse(JSON.stringify(value ?? null));
const saveDoc = (path, value) => setDoc(docRef(path), plain(value));
// 준 필드만 바꾼다. 문서의 나머지 내용은 그대로 둔다.
const mergeDoc = (path, value) => setDoc(docRef(path), plain(value), { merge: true });
const dropDoc = path => deleteDoc(docRef(path));

/* ------------------------------------------------------------------ constants */
const DAYS = ['월', '화', '수', '목', '금', '토', '일'];
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const TIMES = Array.from({ length: 14 }, (_, i) => i + 9); // 9 .. 22
const END_TIMES = TIMES.slice(1).concat([23]);
const PROJECT_COLORS = ['#2f7df6', '#1098ad', '#2f9e44', '#66a80f', '#f08c00', '#e8590c', '#e03131', '#e64980', '#ae3ec9', '#7048e8', '#5c7cfa', '#0c8599', '#495057', '#c2255c'];
const TM_PASTELS = [
  { bg: '#eef4ff', line: '#cbdcff' },
  { bg: '#f1eeff', line: '#d7ceff' },
  { bg: '#eef1f7', line: '#d4dbe8' },
  { bg: '#f6efff', line: '#e3d2f8' },
  { bg: '#edf6fb', line: '#cce4f0' },
];
const DEPARTMENT_ORDER = ['기획부', '아나운서부', '기술부'];
const PROJECT_ROLE_DEFS = [
  ['planning', '기획', '구성·대본'],
  ['production', '촬영/편집', '카메라·후반 작업'],
  ['cast', '출연', '진행·인터뷰·배우'],
];

/* ------------------------------------------------------------------ state */
const state = {
  view: new URLSearchParams(location.search).get('view') || (window.matchMedia('(max-width: 760px)').matches ? 'home' : 'week'), // home is the mobile dashboard
  weekOffset: 0,
  weekMode: 'week',             // week | month | list
  selected: new Set(),
  filter: null,                 // Set of member ids, or null = all
  required: new Set(),
  rangeMode: false,
  rangeStart: null,
  shootView: 'grid',            // grid | project
  shootStatusFilter: 'all',
  shootProjectFilter: 'all',
  shootSlide: 0,
  shootOpen: false,
  personalActive: 0,
  personalOpenDepts: new Set(['기획부']),
  settingsOpenDepts: new Set(['기획부']),
  analysisSelected: new Set(),
  analysisStep: 0,              // 0 empty · 1 pick · 2 results
  analysisPicked: null,         // Set of ids once analysis run
  mobileDay: 0,
  mobileShootMode: 'day',
  mobileShootExpanded: '',
  mobileWeekDetail: false,
  memberFilter: 'all',
  memberQuery: '',
  aiSceneIndex: 0,
  aiProjectId: '',
};

const aiState = {
  health: null,
  file: null,
  extractedText: '',
  extracting: false,
  job: null,
  mappings: {},
  pollTimer: null,
  options: { scenes: true, cast: true, locations: true, schedule: true },
  // 기획자가 거는 조건. 강제 묶기/분리, 뺄 날짜, 우선 고려할 배우.
  planOptions: { pinned: [], split: [], excludeDates: [], priorityMembers: [], dateFrom: '', dateTo: '', dayStart: 18, dayEnd: 23 },
};

// firebase data
let base = {}, allWeeks = {}, week = {}, shoots = {}, projects = {}, fixedSchedules = {}, radioSchedules = {};
let appSettings = {};
let organizedMembers = {}, organizedFixed = {}, organizedPersonal = {};
const pendingData = new Set(['members', 'weeks', 'fixedSchedules', 'radioSchedules', 'shoots', 'projects']);
const dataLoadFailures = new Map();

/* ------------------------------------------------------------------ data layer (ported from firebase-bridge.js) */
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dataKey = v => String(v || '미지정').trim().replace(/[.#$[\]/]/g, '_').replace(/\s+/g, '_');
const memberIdFor = name => encodeURIComponent(String(name || '').trim()).replace(/\./g, '%2E');
/* Firestore 문서 경로.
   국원은 부서·이름이 아니라 고정 ID 로 찾는다. 이름이 바뀌어도 참조가 끊기지 않는다. */
const memberDocId = m => {
  if (m?.docId) return m.docId;
  const found = Object.entries(base).find(([, x]) => x.name === m?.name && (!m.department || x.department === m.department));
  return found ? found[0] : '';
};
const newMemberId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);
// 기존 인원이면 그 문서, 새 인원이면 새 ID 를 만든다. 빈 경로로 저장하면 컬렉션이 통째로 망가진다.
const organizedMemberPath = m => `members/${memberDocId(m) || newMemberId()}`;
const fixedPath = m => `members/${memberDocId(m)}/fixedClasses`;
const personalPath = m => `members/${memberDocId(m)}/availability`;

/* 저장은 ISO 날짜(2026-09-10), 화면은 '9월 10일 (목)' 과 '9M7D월' 을 쓴다.
   두 표기를 오가는 변환은 여기 한 곳에만 둔다. */
const isoOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayLabelOf = d => `${d.getMonth() + 1}월 ${d.getDate()}일 (${DAYS[(d.getDay() + 6) % 7]})`;
const weekKeyFromLabel = label => label.replace(/[^0-9월일]/g, '').replace('월', 'M').replace('일', 'D');
function weekStartOf(iso) {
  const d = new Date(`${iso}T12:00:00`);
  const back = appSettings.weekStart === '일요일' ? d.getDay() : (d.getDay() || 7) - 1;
  d.setDate(d.getDate() - back);
  return d;
}
// role 을 빠뜨리면 역할 지정이 저장되지 않는다. 값이 있을 때만 넣어 빈 값으로 덮어쓰지 않는다.
const cleanMemberRecord = (id, m) => ({
  name: m.name, department: m.department || '미지정',
  createdAt: m.createdAt || Date.now(), legacyId: id,
  ...(String(m.role || '').trim() ? { role: String(m.role).trim() } : {}),
});
function withoutMeta(value) { return Object.fromEntries(Object.entries(value || {}).filter(([key]) => key !== '_meta')); }
/* Firestore 문서 목록 -> 화면이 쓰던 메모리 형태.
   화면 로직을 그대로 두기 위해 저장 형태만 바뀌고 메모리 형태는 유지한다. */
function normalizeOrganizedMembers(rows) {
  const out = {};
  for (const { id, data } of rows) {
    if (!data?.name) continue;
    out[id] = { ...cleanMemberRecord(data.legacyId || id, data), docId: id };
  }
  return out;
}
function normalizeOrganizedFixed(rows) {
  // fixedSchedules 는 이름으로 찾는다. 화면 여러 곳이 그렇게 쓰고 있다.
  const out = {};
  for (const { memberId, id, data } of rows) {
    const m = base[memberId];
    if (!m) continue;
    (out[m.name] ??= {})[id] = data;
  }
  return out;
}
function normalizeOrganizedPersonal(rows) {
  const out = {};
  for (const { memberId, id, data } of rows) {
    const m = base[memberId];
    if (!m || !id) continue;
    const date = new Date(`${id}T12:00:00`);
    if (Number.isNaN(date.getTime())) continue;
    const weekId = weekKeyFromLabel(dayLabelOf(weekStartOf(id)));
    const bucket = ((out[weekId] ??= {})[memberId] ??= { name: m.name, mandatory: false, schedules: {} });
    if (data.mandatory) bucket.mandatory = true;
    bucket.schedules[dayLabelOf(date)] = data;
  }
  return out;
}
const projectOf = s => { const p = s && s.projectId && projects[s.projectId]; return p ? { id: s.projectId, ...p } : null; };
function shootDisplayGroups(items = []) {
  const groups = [];
  const sorted = items.map(item => ({ ...item })).sort((a, b) => String(a.date).localeCompare(String(b.date)) || (+a.startH - +b.startH));
  for (const item of sorted) {
    const project = projectOf(item);
    const previous = groups.at(-1);
    const sameRun = previous && previous.date === item.date && previous.projectId && previous.projectId === item.projectId && +previous.endH === +item.startH;
    if (sameRun) {
      previous.endH = Math.max(+previous.endH, +item.endH);
      previous.sourceIds.push(item.id);
      previous.sceneTitles.push(...(Array.isArray(item.scenes) ? item.scenes.map(scene => scene.sceneId || scene.title).filter(Boolean) : [item.title].filter(Boolean)));
      previous.cast = [...new Map([...(previous.cast || []), ...(item.cast || [])].map(person => [person.id || person.name, person])).values()];
      previous.location = [...new Set([previous.location, item.location].filter(Boolean))].join(', ');
      previous.note = [...new Set([previous.note, item.note].filter(Boolean))].join(' · ');
      continue;
    }
    groups.push({
      ...item,
      title: project?.name || item.title || '촬영',
      sourceIds: [item.id],
      sceneTitles: Array.isArray(item.scenes) ? item.scenes.map(scene => scene.sceneId || scene.title).filter(Boolean) : [item.title].filter(Boolean),
    });
  }
  return groups;
}
function projectRoles(project = {}) {
  if (project.roles) return Object.fromEntries(PROJECT_ROLE_DEFS.map(([key]) => [key, Array.isArray(project.roles[key]) ? project.roles[key] : []]));
  return { planning: Array.isArray(project.members) ? project.members : [], production: [], cast: [] };
}
function requiredProjectCrew(projectId) {
  const roles = projectRoles(projects[projectId] || {});
  if (projectId && projects[projectId] && (!(roles.planning || []).length || !(roles.production || []).length)) {
    throw new Error(`${projects[projectId].name || '선택한 프로젝트'}의 기획·촬영/편집 담당을 먼저 지정하세요.`);
  }
  return [...new Map([...(roles.planning || []), ...(roles.production || [])]
    .filter(person => person?.id && base[person.id]).map(person => [person.id, { id: person.id, name: base[person.id].name }])).values()];
}
const withRequiredProjectCrew = (projectId, cast = []) => [...new Map([
  ...(Array.isArray(cast) ? cast : []), ...requiredProjectCrew(projectId),
].filter(person => person?.id).map(person => [person.id, { id: person.id, name: base[person.id]?.name || person.name || '' }])).values()];
const fmtShootDate = iso => { const d = new Date(`${iso}T00:00`); return isNaN(d) ? String(iso || '') : `${d.getMonth() + 1}.${d.getDate()}(${DAYS[(d.getDay() + 6) % 7]})`; };

// 주 시작 요일 설정(월/일)을 반영해 이번 주 첫 날을 구한다.
const monday = () => { const d = new Date(); d.setHours(12, 0, 0, 0);
  const back = appSettings.weekStart === '일요일' ? d.getDay() : (d.getDay() || 7) - 1;
  d.setDate(d.getDate() - back + state.weekOffset * 7); return d; };
const dates = () => Array.from({ length: 7 }, (_, i) => { const d = monday(); d.setDate(d.getDate() + i); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DAYS[(d.getDay() + 6) % 7]})`; });
const weekKey = () => dates()[0].replace(/[^0-9월일]/g, '').replace('월', 'M').replace('일', 'D');
const storageWeekKey = () => Object.hasOwn(allWeeks, weekKey()) ? weekKey() : Object.hasOwn(allWeeks, `${weekKey()}월`) ? `${weekKey()}월` : `${weekKey()}월`;
const syncWeek = () => { week = allWeeks[storageWeekKey()] || {}; };

const memberWeek = (id, m) => week[id] || week[m.name?.trim().replace(/[.#$[\]]/g, '_')] || Object.values(week).find(x => x?.name === m.name) || {};
const fixedKey = m => m.name?.trim().replace(/[.#$[\]]/g, '_');

function radioFor(day, key) {
  const slot = `${DAY_KEYS[day]}_${key}`;
  const weekly = radioSchedules.weekly?.[storageWeekKey()]?.[slot];
  const semester = radioSchedules.semester?.[slot];
  const legacy = radioSchedules[slot];
  return weekly || semester || legacy || null;
}
const radioMembers = item => !item ? [] : Array.isArray(item.members) ? item.members.filter(Boolean) : item.memberId ? [{ id: item.memberId, name: item.memberName }] : [];
function radioCurrentMap() {
  return Object.fromEntries(
    DAYS.slice(0, 5).flatMap((_, day) => ['lunch', 'dinner'].map(key => {
      const item = radioFor(day, key);
      return [`${DAY_KEYS[day]}_${key}`, item];
    })).filter(([, item]) => item)
  );
}
function fixedMap(id, m) {
  const out = Object.fromEntries(DAY_KEYS.map(k => [k, [...((m.fixedSchedule || {})[k] || [])]]));
  Object.entries(fixedSchedules[fixedKey(m)] || {}).forEach(([itemId, item]) => {
    if (item && DAY_KEYS[item.day]) out[DAY_KEYS[item.day]].push({ start: +item.start, end: +item.end, label: item.title || '수업', itemId, path: `${fixedPath(m)}/${itemId}` });
  });
  Object.entries(radioCurrentMap()).forEach(([itemId, item]) => {
    if (item && radioMembers(item).some(x => x.id === id || x.name === m.name)) {
      const day = DAY_KEYS.findIndex(x => itemId.startsWith(`${x}_`));
      if (day >= 0) out[DAY_KEYS[day]].push({ start: +item.start, end: +item.end, label: item.title || '라디오 방송', itemId, path: `scheduler/라디오방송/${itemId}` });
    }
  });
  return out;
}
const members = () => Object.fromEntries(Object.entries(base).map(([id, m]) => [id, { ...m, ...memberWeek(id, m), __id: id, fixedSchedule: fixedMap(id, m) }]));

// 촬영 일정: 그 주 특정 날짜의 촬영들, 그리고 특정 멤버가 출연자로 잡힌 시간 블록
function shootsOn(day) {
  const iso = isoDate(dayDate(day));
  return Object.values(shoots).filter(s => s && s.date === iso).sort((a, b) => (+a.startH) - (+b.startH));
}
// 촬영에 묶인 인원 = 프로젝트 기획·촬영/편집(모든 씬 고정) + 그 씬의 출연진(씬별로 다름)
function shootMemberIds(s) {
  const ids = new Set((Array.isArray(s.cast) ? s.cast : []).map(c => c.id));
  const proj = projectOf(s);
  if (proj) {
    const roles = projectRoles(proj);
    for (const p of [...(roles.planning || []), ...(roles.production || [])]) if (p?.id) ids.add(p.id);
  }
  return ids;
}
/** 촬영끼리 시간이 겹쳐도 사람이 안 겹치면 같이 찍을 수 있다.
    막는 건 '같은 사람이 같은 시간에 두 촬영'뿐이다. 판정은 여기 한 곳에서만 한다. */
function shootConflicts(record = {}) {
  const date = String(record.date || '');
  const start = Number(record.startH), end = Number(record.endH);
  if (!date || !(end > start)) return [];
  const self = String(record.id || '');
  // castIds 를 주면 그걸 쓰고, cast 만 주면 거기서 뽑는다. 기획·제작진도 사람이다.
  const wanted = new Set(withRequiredProjectCrew(record.projectId || null,
    Array.isArray(record.cast) ? record.cast : (Array.isArray(record.castIds) ? record.castIds.map(id => ({ id })) : []))
    .map(person => person.id).filter(Boolean));
  for (const id of (Array.isArray(record.castIds) ? record.castIds : [])) if (id) wanted.add(String(id));
  if (!wanted.size) return [];
  const out = [];
  for (const [id, shoot] of Object.entries(shoots)) {
    if (!shoot || id === self || shoot.date !== date) continue;
    if (!(start < +shoot.endH && end > +shoot.startH)) continue;   // 시간이 안 겹치면 볼 것 없다
    const people = [...shootMemberIds(shoot)].filter(x => wanted.has(x))
      .map(x => base[x]?.name || '').filter(Boolean);
    if (!people.length) continue;                                   // 사람이 안 겹치면 통과
    out.push({ shootId: id, title: shoot.title || '촬영',
      time: `${shoot.startH}\uc2dc\u2013${shoot.endH}\uc2dc`, date: shoot.date, people });
  }
  return out;
}
function shootBlocksFor(memberId, day) {
  return shootsOn(day)
    .filter(s => shootMemberIds(s).has(memberId))
    .map(s => ({ start: +s.startH, end: +s.endH, label: s.title || '촬영' }));
}

function subtract(src, blocks = []) {
  let out = src;
  for (const x of blocks) out = out.flatMap(r => r.end <= x.start || r.start >= x.end ? [r] : [{ start: r.start, end: x.start }, { start: x.end, end: r.end }]).filter(r => r.end > r.start);
  return out;
}
function mergeRanges(items = []) {
  return items.map(x => ({ start: +x.start, end: +x.end })).filter(x => x.end > x.start).sort((a, b) => a.start - b.start)
    .reduce((out, item) => {
      const last = out.at(-1);
      if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
      else out.push({ ...item });
      return out;
    }, []);
}
function personalRanges(item) {
  if (!item) return { available: [], unavailable: [], overrideFixed: false };
  if (Array.isArray(item.availableRanges) || Array.isArray(item.unavailableRanges)) {
    return { available: mergeRanges(item.availableRanges || []), unavailable: mergeRanges(item.unavailableRanges || []), overrideFixed: true };
  }
  const legacy = Array.isArray(item.ranges) ? item.ranges : [];
  if (item.status === '불가능') return { available: [], unavailable: mergeRanges(legacy.length ? legacy : [{ start: 9, end: 23 }]), overrideFixed: false };
  if (item.status === '가능' && item.entryMode && item.entryMode !== 'available') return { available: [], unavailable: mergeRanges(legacy), overrideFixed: false };
  return { available: item.status === '가능' ? mergeRanges(legacy) : [], unavailable: [], overrideFixed: item.entryMode === 'available' };
}
// 회의·라디오 방송·촬영 = 절대 불가. 개인 '가능'은 겹치는 수업 구간만 덮는다.
const isHardBlock = f => f.itemId === 'weekly_meeting' || /라디오방송/.test(f.path || '');
/** 어떤 날짜든 그 사람의 가능 시간을 구한다. 보고 있는 주에 매이지 않는다. */
function rangesOn(m, iso) {
  const date = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(date.getTime())) return [];
  const dayIndex = (date.getDay() + 6) % 7;
  // 저장된 개인 일정은 주 단위로 묶여 있으니 그 날이 속한 주에서 꺼낸다.
  const record = m?.__id ? allWeeks[weekKeyFromLabel(dayLabelOf(weekStartOf(iso)))]?.[m.__id] : null;
  const p = record?.schedules?.[dayLabelOf(date)] ?? m?.schedules?.[dayLabelOf(date)];
  const allFixed = m?.fixedSchedule?.[DAY_KEYS[dayIndex]] || [];
  const hardFixed = allFixed.filter(isHardBlock);
  const softFixed = allFixed.filter(f => !isHardBlock(f));
  // 수업을 뺀 기본 가능 시간에 명시적 '가능' 구간을 다시 합쳐, 겹친 수업 부분만 복구한다.
  const explicit = personalRanges(p);
  const baseRanges = subtract([{ start: 9, end: 23 }], [...softFixed, ...explicit.unavailable]);
  const merged = mergeRanges([...baseRanges, ...explicit.available]);
  const shootBlocks = m?.__id ? Object.values(shoots)
    .filter(s => s && s.date === iso && shootMemberIds(s).has(m.__id))
    .map(s => ({ start: +s.startH, end: +s.endH, label: s.title || '촬영' })) : [];
  const hardBlocks = [...hardFixed, ...shootBlocks];
  return hardBlocks.length ? subtract(merged, hardBlocks) : merged;
}
function ranges(m, day) { return rangesOn(m, isoDate(dayDate(day))); }
const can = (m, d, t) => ranges(m, d).some(r => +r.start <= t && +r.end >= t + 1);
const entries = ids => Object.entries(members()).filter(([id]) => !ids || ids.has(id));
function info(day, time, ids = state.filter) {
  const all = entries(ids);
  const yes = all.filter(([, m]) => can(m, day, time));
  const yesIds = new Set(yes.map(([id]) => id));
  return { day, time, all, yes, missing: [...state.required].filter(id => !yesIds.has(id)).map(id => members()[id]?.name).filter(Boolean) };
}
const bg = s => s.yes.length <= 3 ? '#fde9e8' : s.yes.length === s.all.length && s.all.length ? '#e2f3ed' : '#fff4d7';
const slotFg = s => s.yes.length <= 3 ? '#a33c46' : s.yes.length === s.all.length && s.all.length ? '#217052' : '#806018';

const departmentRank = d => { const i = DEPARTMENT_ORDER.indexOf(d || '미지정'); return i < 0 ? DEPARTMENT_ORDER.length : i; };
const sortedPeople = () => Object.entries(base).sort(([, a], [, b]) => departmentRank(a.department) - departmentRank(b.department) || (a.department || '').localeCompare(b.department || '', 'ko') || a.name.localeCompare(b.name, 'ko'));

function fixedItems(id, m) {
  const modern = Object.entries(fixedSchedules[fixedKey(m)] || {}).map(([itemId, item]) => ({ ...item, itemId, path: `${fixedPath(m)}/${itemId}` }));
  return modern.sort((a, b) => a.day - b.day || a.start - b.start);
}
const radioItems = () => Object.entries(radioCurrentMap()).map(([itemId, item]) => ({ ...item, itemId, path: `scheduler/라디오방송/${itemId}` })).sort((a, b) => a.day - b.day || a.start - b.start);

const weekLabel = () => { const start = monday(), end = new Date(start); end.setDate(start.getDate() + 6); const f = d => `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}`; return `${f(start)} — ${f(end)}`; };
const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const analysisDate = day => { const d = monday(); d.setDate(d.getDate() + day); return isoDate(d); };
const dayDate = i => { const d = monday(); d.setDate(d.getDate() + i); return d; };

/* ------------------------------------------------------------------ small ui helpers */
const $app = () => document.getElementById('app');
function toast(msg) {
  let t = document.getElementById('liveToast');
  if (!t) { t = document.createElement('div'); t.id = 'liveToast'; document.body.append(t); }
  t.textContent = msg; t.classList.add('open');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('open'), 1900);
}
/** 연결 로그에 남긴다. 부모 프레임이 없거나 막혀 있어도 앱은 그대로 돌아가야 한다. */
function logEvent(level, message) {
  try { window.parent?.hnubsLog?.(level, message); } catch { /* 로그는 실패해도 무시한다 */ }
}
function reportError(context, error) {
  console.error(`[HNUBS] ${context} 실패`, error);
  logEvent('error', `${context} 실패 · ${error?.message || error}`);
  toast(`${context}에 실패했습니다. 잠시 후 다시 시도해 주세요.`);
}
function markLoaded(key, ok = true) {
  pendingData.delete(key);
  if (ok) dataLoadFailures.delete(key);
  if (!pendingData.size) finishInitialLoad();
}
function finishInitialLoad() {
  logEvent('act', `데이터 불러오기 완료 · 인원 ${Object.keys(base).length}명 · 촬영 ${Object.keys(shoots).length}건`);
  document.getElementById('dataLoader')?.classList.add('done');
  requestAnimationFrame(() => document.getElementById('appSplash')?.classList.add('is-ready'));
}
function failDataLoad(key, label, error) {
  console.error(`[HNUBS] ${label} 실패`, error);
  logEvent('error', `${label} 실패 · ${error?.message || error}`);
  dataLoadFailures.set(key, label);
  markLoaded(key, false);
  render();
}
function renderDataWarning() {
  if (!dataLoadFailures.size) return '';
  return `<aside class="data-warning" role="status"><i class="fa-solid fa-triangle-exclamation"></i><span><b>일부 데이터를 불러오지 못했습니다.</b><small>${[...dataLoadFailures.values()].map(esc).join(', ')}</small></span><button data-act="data-reload">다시 불러오기</button></aside>`;
}
const setState = patch => { Object.assign(state, typeof patch === 'function' ? patch(state) : patch); render(); };

/* ================================================================== RENDER */
const TAB_DEFS = [
  ['week', '주간 일정표', 'fa-regular fa-calendar'],
  ['ai', 'AI 분석', 'fa-solid fa-wand-magic-sparkles'],
  ['shoot', '촬영 일정', 'fa-solid fa-camera'],
  ['personal', '개인 일정 관리', 'fa-regular fa-user'],
  ['members', '인원 관리', 'fa-solid fa-user-group'],
  ['settings', '설정', 'fa-solid fa-gear'],
];
const DEPTS_LEGEND = [
  { label: '전체 인원', dot: '#7b52ff' }, { label: '기획부', dot: '#7b52ff' },
  { label: '아나운서부', dot: '#ef6887' }, { label: '기술부', dot: '#2cac82' },
];
const SLOT_LEGEND = [['#e2f3ed', '전 인원 가능'], ['#fff4d7', '일부 가능'], ['#fde9e8', '3명 이하'], ['#e2e9f3', '촬영 일정']];

function renderSidebar() {
  const nav = TAB_DEFS.map(([id, label, icon]) => `
    <button data-act="tab" data-tab="${id}" class="side-tab${state.view === id ? ' is-active' : ''}">
      <i class="${icon}"></i><span>${label}</span>
    </button>`).join('');
  return `
  <aside class="sidebar">
    <div class="brand">
      <span class="hn-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
      <div><strong>HNUBS</strong><small>방송국 스케줄러</small></div>
    </div>
    <nav>${nav}</nav>
    <div class="side-signature"><b>On Air<br>Together</b><span>HANBAT NATIONAL<br>UNIVERSITY BROADCAST STATION</span></div>
  </aside>`;
}

function renderMobileBottomNav() {
  const tabs = [
    ['home', '홈', 'fa-solid fa-house'],
    ['week', '주간 일정', 'fa-regular fa-calendar'],
    ['shoot', '촬영 일정', 'fa-solid fa-camera'],
    ['personal', '개인 일정', 'fa-regular fa-user'],
    ['ai', 'AI 분석', 'fa-solid fa-wand-magic-sparkles'],
  ];
  return `<nav class="mobile-bottom-nav" aria-label="모바일 메뉴">${tabs.map(([id, label, icon]) => `<button data-act="tab" data-tab="${id}" class="${state.view === id ? 'is-active' : ''}"><i class="${icon}"></i><span>${label}</span></button>`).join('')}</nav>`;
}

function weekNav(actPrefix, showLabel = true) {
  return `<div class="week-nav">
    <button data-act="${actPrefix}-prev" aria-label="이전 주"><i class="fa-solid fa-chevron-left"></i></button>
    <button data-act="${actPrefix}-today">오늘</button>
    <button data-act="${actPrefix}-next" aria-label="다음 주"><i class="fa-solid fa-chevron-right"></i></button>
    ${showLabel ? `<span class="week-nav-label">${esc(weekLabel())}</span>` : ''}
  </div>`;
}

/* ----- week view ----- */
function gridTable(cellFn, { slotClass = 'live-slot', headSmall = true } = {}) {
  const ds = dates();
  const head = `<tr><th>시간</th>${DAYS.map((d, i) => {
    const m = ds[i].match(/(\d+)월 (\d+)일/);
    return `<th>${d}${headSmall && m ? `<small>${m[1]}/${m[2]}</small>` : ''}</th>`;
  }).join('')}</tr>`;
  const body = TIMES.map(t => `<tr>
    <td class="t-col">${String(t).padStart(2, '0')}:00</td>
    ${DAYS.map((_, day) => {
      const c = cellFn(day, t);
      return `<td class="grid-cell"><div class="${slotClass}${c.sel ? ' selected' : ''}${c.shoot ? ' has-shoot' : ''}" data-act="${c.act || ''}" data-day="${day}" data-time="${t}" style="background:${c.bg};color:${c.fg}${c.shoot ? `;--sc:${c.shootColor}` : ''}" title="${esc(c.title || '')}"><span class="slot-value">${c.text}</span>${c.sub ? `<small class="slot-meta">${esc(c.sub)}</small>` : ''}</div></td>`;
    }).join('')}
  </tr>`).join('');
  return `<div class="grid-scroll"><table class="wk-table">${head}${body}</table></div>`;
}

function renderWeek() {
  const grid = gridTable((day, t) => {
    const s = info(day, t);
    const sh = shootsOn(day).filter(x => +x.startH <= t && +x.endH > t);
    const shootTitle = sh.map(x => {
      const names = [...shootMemberIds(x)].map(id => base[id]?.name).filter(Boolean);
      return x.title + (names.length ? ` (${names.join('·')})` : '');
    }).join(', ');
    const availTitle = s.missing.length ? `필수 인원 불가: ${s.missing.join(', ')}` : `가능: ${s.yes.map(([, m]) => m.name).join(', ')}`;
    return { text: s.yes.length, bg: bg(s), fg: slotFg(s), sel: state.selected.has(`${day}:${t}`), act: 'slot',
      shoot: sh.length > 0, shootColor: projectOf(sh[0])?.color || '#8a96ad',
      title: sh.length ? `촬영: ${shootTitle} · ${availTitle}` : availTitle };
  });

  // summary
  const slots = TIMES.flatMap(t => DAYS.map((_, d) => info(d, t)));
  const max = slots.reduce((a, b) => !a || b.yes.length > a.yes.length ? b : a, null);
  const avg = slots.reduce((n, s) => n + s.yes.length, 0) / Math.max(1, slots.length);
  const dayStats = DAYS.map((_, day) => ({ day, available: TIMES.reduce((n, t) => n + info(day, t).yes.length, 0), registered: Object.values(week).filter(m => m?.schedules?.[dates()[day]]).length }));
  const busy = dayStats.reduce((a, b) => !a || b.available < a.available ? b : a, null);

  const quick = [
    ['filter', 'fa-solid fa-user', '인원 선택', '비교할 인원 선택'],
    ['required', 'fa-solid fa-user-group', '필수 참여 인원', '반드시 포함할 인원'],
    ['ai', 'fa-solid fa-wand-magic-sparkles', 'AI 대본 분석', '대본 기반 촬영 추천'],
    ['copy', 'fa-regular fa-copy', '결과 복사', '계산된 가능 시간 복사'],
  ].map(([act, icon, title, sub]) => `<button class="quick-card" data-act="quick" data-quick="${act}">
    <i class="${icon}"></i><div><b>${title}</b><span>${sub}</span></div></button>`).join('');

  const selInfo = [...state.selected].map(k => { const [d, t] = k.split(':').map(Number); return info(d, t); }).sort((a, b) => a.day - b.day || a.time - b.time);
  let common = [];
  if (selInfo.length) {
    common = selInfo[0].yes.map(([id, m]) => ({ id, name: m.name }));
    selInfo.slice(1).forEach(s => { const ids = new Set(s.yes.map(([id]) => id)); common = common.filter(x => ids.has(x.id)); });
  }
  const selPanel = !selInfo.length
    ? `<div class="empty-mini"><i class="fa-regular fa-calendar"></i>시간대를 선택하면<br>해당 시간의 가능 인원을 확인할 수 있습니다.</div>`
    : `<div class="live-selection"><b>${selInfo.map(s => `${DAYS[s.day]} ${s.time}:00–${s.time + 1}:00`).join(', ')}</b>
        <small>전 구간 가능 ${common.length}명</small>
        <div>${common.map(x => `<span>${esc(x.name)}</span>`).join('') || '<em>가능 인원이 없습니다.</em>'}</div></div>`;

  const modeBtns = [['week', '주'], ['month', '월'], ['list', '목록']].map(([m, l]) =>
    `<button data-act="weekmode" data-mode="${m}" class="${state.weekMode === m ? 'is-active' : ''}">${l}</button>`).join('');
  const scheduleControls = `<div class="schedule-controls"><div class="mode-toggle">${modeBtns}</div>${weekNav('wk', false)}</div>`;

  let mainPanel;
  if (state.weekMode === 'list') {
    const rows = TIMES.flatMap(t => DAYS.map((_, d) => info(d, t))).filter(s => s.yes.length);
    mainPanel = `<div class="mode-card has-toolbar"><div class="wk-card-head">${scheduleControls}</div><div class="mode-card-content"><h3>가능 시간 목록</h3><p>${esc(weekLabel())} · Firebase 등록 일정 기준</p>
      <div class="mode-list">${rows.map(s => `<article><b>${DAYS[s.day]}요일 ${String(s.time).padStart(2, '0')}:00–${s.time + 1}:00</b><strong>${s.yes.length}명 가능</strong><span>${s.yes.map(([, m]) => esc(m.name)).join(', ')}</span></article>`).join('') || '<div class="mode-empty">등록된 가능 시간이 없습니다.</div>'}</div></div></div>`;
  } else if (state.weekMode === 'month') {
    const f = monday(), year = f.getFullYear(), month = f.getMonth();
    const last = new Date(year, month + 1, 0).getDate();
    const lead = (new Date(year, month, 1).getDay() + 6) % 7;
    const cells = Array(lead).fill(null).concat(Array.from({ length: last }, (_, i) => new Date(year, month, i + 1)));
    mainPanel = `<div class="mode-card has-toolbar"><div class="wk-card-head">${scheduleControls}</div><div class="mode-card-content"><h3>${year}년 ${month + 1}월</h3><p>날짜별 Firebase 일정 등록 현황</p>
      <div class="month-grid">${DAYS.map(x => `<b>${x}</b>`).join('')}${cells.map(d => {
        if (!d) return '<span class="blank"></span>';
        const label = `${d.getMonth() + 1}월 ${d.getDate()}일 (${DAYS[(d.getDay() + 6) % 7]})`;
        const count = Object.values(week).filter(m => m?.schedules?.[label]).length;
        return `<article class="${count ? 'has-data' : ''}"><strong>${d.getDate()}</strong><small>${count ? `${count}명 등록` : '미등록'}</small></article>`;
      }).join('')}</div></div></div>`;
  } else {
    mainPanel = `<div class="wk-card">
      <div class="wk-card-head">
        ${scheduleControls}
        <div class="legend">${SLOT_LEGEND.map(([c, t]) => `<span><i class="sq" style="background:${c}"></i>${t}</span>`).join('')}</div>
      </div>
      ${grid}
      <div class="wk-hint"><i class="fa-regular fa-lightbulb"></i> 시간대를 눌러 선택하고, AI 대본 분석에서 등장인물 기준 촬영 후보를 만들 수 있습니다.</div>
    </div>`;
  }

  return `<main class="view week-view">
    <header class="view-head">
      <div class="view-title-row"><div><h1>주간 일정표</h1><p class="sub">한눈에 보는 이번 주 촬영 가능 인원</p></div><div class="page-week-nav">${weekNav('wk')}</div></div>
    </header>
    <section class="week-command-bar">${quick}<button class="week-analyze-button" data-act="quick" data-quick="ai"><i class="fa-solid fa-wand-magic-sparkles"></i> 시간대 분석하기</button></section>
    <div class="wk-layout">
      ${mainPanel}
      <div class="wk-side">
        <div class="panel"><div class="panel-head"><h3>이번 주 요약</h3></div>
          <div class="summary-list">
            <div class="summary-row"><span class="s-ico" style="background:#eaf3ff;color:#2f7df6"><i class="fa-solid fa-user-group"></i></span><span class="summary-txt"><b>최대 가능 인원</b><span>${max ? `${DAYS[max.day]}요일 ${max.time}:00` : '-'}</span></span><strong>${max?.yes.length || 0}명</strong></div>
            <div class="summary-row"><span class="s-ico" style="background:#fff6e0;color:#c98a10"><i class="fa-regular fa-clock"></i></span><span class="summary-txt"><b>바쁜 요일</b><span>${busy ? `등록 ${busy.registered}명 기준` : '-'}</span></span><strong>${busy ? `${DAYS[busy.day]}요일` : '-'}</strong></div>
            <div class="summary-row"><span class="s-ico" style="background:#f4efff;color:#7b52ff"><i class="fa-regular fa-calendar"></i></span><span class="summary-txt"><b>주 평균 가능 인원</b><span>${max ? `이번 주 등록 기준` : '-'}</span></span><strong>${avg.toFixed(1)}명</strong></div>
          </div>
        </div>
        <div class="panel"><div class="panel-head"><h3>선택한 시간대</h3>${state.selected.size ? '<button class="link" data-act="quick" data-quick="clear">초기화</button>' : ''}</div>${selPanel}</div>
      </div>
    </div>
  </main>`;
}

/* ----- analysis view ----- */
function renderAnalysis() {
  const ids = state.analysisStep === 2 ? state.analysisPicked : null;
  const grid = gridTable((day, t) => {
    const s = info(day, t, ids);
    const isSel = state.analysisStep === 2 && state.analysisSelected.has(`${day}:${t}`);
    const sh = shootsOn(day).filter(x => +x.startH <= t && +x.endH > t);
    return { text: s.yes.length, bg: bg(s), fg: slotFg(s), sel: isSel,
      shoot: sh.length > 0, shootColor: projectOf(sh[0])?.color || '#8a96ad',
      act: state.analysisStep === 2 ? 'aslot' : '',
      title: (sh.length ? `촬영: ${sh.map(x => x.title).join(', ')} · ` : '') + `가능: ${s.yes.map(([, m]) => m.name).join(', ') || '없음'}` };
  });

  const steps = ['인원 선택', '시간 분석', '결과 확인'];
  const progress = `<div class="analysis-progress">
    <div class="analysis-steps">${steps.map((s, i) => `<span class="${i <= state.analysisStep ? 'active' : ''}"><i></i><b>${s}</b></span>${i < 2 ? '<em></em>' : ''}`).join('')}</div>
    ${weekNav('an', false)}
  </div>`;

  let sideInner;
  if (state.analysisStep === 0) {
    sideInner = `<div class="analysis-empty"><i class="fa-solid fa-user-group"></i><b>분석할 인원을 선택하세요</b><span>가능 시간 분석을 누른 후 참여자를 선택하세요.</span><button data-act="analysis-start">가능 시간 분석</button></div>`;
  } else if (state.analysisStep === 1) {
    const groups = Object.entries(base).reduce((o, it) => { const d = it[1].department || '미지정'; (o[d] ??= []).push(it); return o; }, {});
    sideInner = `<div class="analysis-choose">
      <b>분석할 인원을 선택하세요</b>
      <div>${Object.entries(groups).sort(([a], [b]) => departmentRank(a) - departmentRank(b)).map(([dept, its]) => `
        <section><header><b>${esc(dept)}</b><button type="button" data-act="dept-toggle" data-dept="${esc(dept)}">부서 전체</button></header>
        <div>${its.sort(([, a], [, b]) => a.name.localeCompare(b.name, 'ko')).map(([id, m]) => `<label><input type="checkbox" value="${esc(id)}" checked><span>${esc(m.name)}</span></label>`).join('')}</div></section>`).join('')}</div>
      <button data-act="analysis-run">분석하기</button>
    </div>`;
  } else {
    const picked = [...state.analysisPicked];
    const full = TIMES.flatMap(t => DAYS.map((_, d) => info(d, t, state.analysisPicked))).filter(s => s.yes.length === picked.length && picked.length);
    sideInner = `<div class="analysis-results">
      <b>선택 인원 ${picked.length}명</b>
      <div class="analysis-names">${picked.map(id => `<span>${esc(members()[id]?.name)}</span>`).join('')}</div>
      <h4>모두 가능한 시간</h4>
      <div class="analysis-list">${full.map(s => `<div><b>${DAYS[s.day]}요일 ${s.time}:00–${s.time + 1}:00</b><span>${s.yes.length}명 모두 가능</span></div>`).join('') || '<p>모두 가능한 시간이 없습니다.</p>'}</div>
      <button data-act="analysis-again">인원 다시 선택</button>
    </div>`;
  }

  const selList = [...state.analysisSelected].map(k => { const [d, t] = k.split(':').map(Number); return { d, t }; }).sort((a, b) => a.d - b.d || a.t - b.t);
  const selTimes = selList.length
    ? selList.map(x => `<span>${DAYS[x.d]}요일 ${String(x.t).padStart(2, '0')}:00–${String(x.t + 1).padStart(2, '0')}:00</span>`).join('')
    : `<span class="analysis-selection-empty"><i class="fa-regular fa-calendar"></i>시간대를 선택하면<br>해당 시간의 가능 인원을 확인할 수 있습니다.</span>`;

  return `<main class="view">
    <header class="view-head"><div class="view-title-row"><h1>시간 분석</h1></div></header>
    <div class="analysis-layout">
      ${progress}
      <div class="analysis-grid-wrap">${grid}</div>
      <div class="analysis-right">
        <div class="analysis-side">
          <div class="analysis-head"><h3>주간 촬영 가능 시간 분석</h3><button data-act="analysis-copy"><i class="fa-regular fa-copy"></i> 복사</button></div>
          ${sideInner}
        </div>
        <div class="analysis-side analysis-selected-times">
          <div class="analysis-head"><h3>선택한 시간대</h3><button type="button" data-act="analysis-sel-clear">초기화</button></div>
          <div class="sel-times">${selTimes}</div>
          <button type="button" class="analysis-shoot-add" data-act="analysis-shoot-add" ${state.analysisSelected.size ? '' : 'disabled'}>선택한 시간대로 촬영 일정 추가</button>
        </div>
      </div>
    </div>
  </main>`;
}

/* ----- shoot view ----- */
function renderShoot() {
  const allItems = shootDisplayGroups(Object.entries(shoots).map(([id, s]) => ({ id, ...s })));
  const projectList = Object.entries(projects).map(([id, p]) => ({ id, ...p })).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const items = allItems.filter(s => state.shootProjectFilter === 'all' || s.projectId === state.shootProjectFilter);
  const dd = Array.from({ length: 7 }, (_, i) => dayDate(i));
  const weekStart = isoDate(dd[0]), weekEnd = isoDate(dd[6]);
  const weekItems = items.filter(s => s.date >= weekStart && s.date <= weekEnd).sort((a, b) => String(a.date).localeCompare(String(b.date)) || (+a.startH - +b.startH));
  const occupied = Array(7).fill(0);
  const rows = TIMES.map((time, ri) => {
    let cells = `<th>${String(time).padStart(2, '0')}:00</th>`;
    for (let day = 0; day < 7; day++) {
      if (occupied[day] > 0) { occupied[day]--; continue; }
      const event = weekItems.find(s => s.date === isoDate(dd[day]) && +s.startH === time);
      if (!event) {
        cells += `<td class="shoot-empty-cell" data-act="shoot-add" data-date="${isoDate(dd[day])}" data-start="${time}" data-end="${time + 1}" title="촬영 일정 추가"></td>`;
        continue;
      }
      const span = Math.max(1, Math.min(TIMES.length - ri, +event.endH - +event.startH));
      occupied[day] = span - 1;
      const project = projectOf(event);
      const evCast = (Array.isArray(event.cast) ? event.cast : []).map(c => c.name).join(', ');
      cells += `<td rowspan="${span}" class="shoot-event-cell" data-act="shoot-edit" data-id="${esc(event.id)}" style="--pc:${project?.color || '#2475f5'}"><div><b>${esc(event.title || '촬영')}</b><span>${String(event.startH).padStart(2, '0')}:00–${String(event.endH).padStart(2, '0')}:00</span>${evCast ? `<small class="cast">${esc(evCast)}</small>` : ''}${event.location ? `<small>${esc(event.location)}</small>` : ''}</div></td>`;
    }
    return `<tr>${cells}</tr>`;
  }).join('');
  const calendar = `<section class="shoot-calendar-card"><div class="shoot-calendar-toolbar"><div class="shoot-project-filters"><button data-act="shoot-filter" data-pid="all" class="${state.shootProjectFilter === 'all' ? 'is-active' : ''}">전체 프로젝트</button>${projectList.map(p => `<button data-act="shoot-filter" data-pid="${esc(p.id)}" class="${state.shootProjectFilter === p.id ? 'is-active' : ''}" style="--pc:${p.color}"><i></i>${esc(p.name)}</button>`).join('')}</div>${weekNav('sh')}</div><div class="grid-scroll"><table class="shoot-calendar-table"><thead><tr><th>시간</th>${DAYS.map((d, i) => `<th>${d}<small>${dd[i].getMonth() + 1}/${dd[i].getDate()}</small></th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div><p class="shoot-calendar-hint"><i class="fa-regular fa-circle-info"></i> 빈 칸을 누르면 해당 시간으로 촬영 일정을 바로 추가할 수 있습니다.</p></section>`;
  const monthYear = dd[0].getFullYear(), monthIndex = dd[0].getMonth();
  const monthStartDate = new Date(monthYear, monthIndex, 1, 12), monthEndDate = new Date(monthYear, monthIndex + 1, 0, 12);
  const monthStart = isoDate(monthStartDate), monthEnd = isoDate(monthEndDate);
  const monthItems = items.filter(s => s.date >= monthStart && s.date <= monthEnd);
  const firstMonday = new Date(monthStartDate); firstMonday.setDate(firstMonday.getDate() - ((firstMonday.getDay() + 6) % 7));
  const monthWeeks = [];
  for (let start = new Date(firstMonday), index = 1; start <= monthEndDate; start.setDate(start.getDate() + 7), index++) {
    const end = new Date(start); end.setDate(end.getDate() + 6);
    const visibleStart = start < monthStartDate ? monthStartDate : start, visibleEnd = end > monthEndDate ? monthEndDate : end;
    const from = isoDate(visibleStart), to = isoDate(visibleEnd);
    const count = monthItems.filter(s => s.date >= from && s.date <= to).length;
    const current = weekStart <= to && weekEnd >= from;
    monthWeeks.push(`<div class="shoot-month-week${current ? ' is-current' : ''}"><span><b>${index}주차</b><small>${visibleStart.getMonth() + 1}/${visibleStart.getDate()}–${visibleEnd.getMonth() + 1}/${visibleEnd.getDate()}</small></span><strong>${count}건</strong></div>`);
  }
  const agenda = `<aside class="shoot-agenda-card"><div class="shoot-agenda-head"><div><h3>${monthIndex + 1}월 촬영 일정</h3><span>총 ${monthItems.length}건</span></div><button data-act="shoot-add" aria-label="촬영 일정 추가"><i class="fa-solid fa-plus"></i></button></div><div class="shoot-month-summary">${monthWeeks.join('')}</div></aside>`;
  let timeMachine = '';
  if (projectList.length) {
    state.shootSlide = Math.max(0, Math.min(state.shootSlide, projectList.length - 1));
    const stack = projectList.map((p, i) => {
      const offset = i - state.shootSlide, selected = i === state.shootSlide, open = selected && state.shootOpen;
      const projectShoots = allItems.filter(s => s.projectId === p.id).sort((a, b) => String(a.date).localeCompare(String(b.date)) || (+a.startH - +b.startH));
      const roles = projectRoles(p);
      const roleSummary = PROJECT_ROLE_DEFS.map(([key, label]) => `${label} ${roles[key].length}명`).join(' · ');
      const detailRows = projectShoots.map(s => { const c = (Array.isArray(s.cast) ? s.cast : []).map(x => x.name).join(', '); return `<li data-act="shoot-edit" data-id="${esc(s.id)}"><b>${esc(fmtShootDate(s.date))}</b><span>${esc(s.title || '촬영')}</span><em>${String(s.startH).padStart(2, '0')}:00–${String(s.endH).padStart(2, '0')}:00${s.location ? ' · ' + esc(s.location) : ''}${c ? ' · ' + esc(c) : ''}</em></li>`; }).join('') || '<li class="tm-none">등록된 촬영이 없습니다.</li>';
      const detail = open ? `<div class="tm-detail"><div class="tm-detail-meta">${projectShoots.length}개 촬영</div><ul class="tm-shoots">${detailRows}</ul><button class="tm-add btn-primary" data-act="shoot-add" data-pid="${esc(p.id)}"><i class="fa-solid fa-plus"></i> 이 프로젝트에 촬영 추가</button></div>` : '';
      const pastel = TM_PASTELS[i % TM_PASTELS.length];
      return `<article class="tm-card${selected ? ' is-active' : ''}" style="--pc:${p.color};--tm-bg:${pastel.bg};--tm-line:${pastel.line};z-index:${projectList.length - Math.abs(offset)};transform:translateY(${offset * 22}px) scale(${(1 - Math.abs(offset) * 0.05).toFixed(3)});opacity:${Math.abs(offset) > 2 ? 0 : selected ? 1 : 0.4}" data-act="shoot-project-detail" data-pid="${esc(p.id)}" data-i="${i}"><div class="tm-card-actions"><button data-act="project-edit" data-pid="${esc(p.id)}" aria-label="프로젝트 수정"><i class="fa-regular fa-pen-to-square"></i></button><button data-act="project-delete" data-pid="${esc(p.id)}" aria-label="프로젝트 삭제"><i class="fa-regular fa-trash-can"></i></button></div><div class="tm-core"><strong class="tm-title">${esc(p.name)}</strong><span class="tm-people">${roleSummary} · 촬영 ${projectShoots.length}개</span><small>카드를 눌러 가운데에서 전체 기록 보기</small></div></article>`;
    }).join('');
    const rail = projectList.map((p, i) => `<button class="tm-node${i === state.shootSlide ? ' is-active' : ''}" data-act="shoot-slide" data-i="${i}" style="--pc:${p.color}" title="${esc(p.name)}"><span>${esc(p.name)}</span><i></i></button>`).join('');
    timeMachine = `<section class="shoot-project-machine"><header><h3>프로젝트 타임머신</h3><button class="shoot-head-btn" data-act="project-open"><i class="fa-regular fa-folder-open"></i> 프로젝트 관리</button></header><div class="tm-shell"><div class="tm-machine-nav"><button data-act="shoot-machine-prev" aria-label="이전 프로젝트"><i class="fa-solid fa-chevron-left"></i></button><span>${state.shootSlide + 1} / ${projectList.length}</span><button data-act="shoot-machine-next" aria-label="다음 프로젝트"><i class="fa-solid fa-chevron-right"></i></button></div><div class="tm-stage" id="tmStage">${stack}</div><div class="tm-rail">${rail}</div></div></section>`;
  }
  return `<main class="view shoot-view"><header class="view-head"><div class="view-title-row"><div><h1>촬영 일정</h1><p class="sub">촬영 계획을 한 주 단위로 추가하고 관리합니다.</p></div><button class="btn-primary shoot-add-primary" data-act="shoot-add"><i class="fa-solid fa-plus"></i> 촬영 일정 추가</button></div></header><div class="shoot-planner">${calendar}<div class="shoot-side">${timeMachine}${agenda}</div></div></main>`;
}

function renderShootReference() {
  const all = shootDisplayGroups(Object.entries(shoots).map(([id,s])=>({id,...s})));
  const dd = Array.from({length:7},(_,i)=>dayDate(i));
  const from=isoDate(dd[0]), to=isoDate(dd[6]);
  const today=isoDate(new Date());
  const statusOk=s=>state.shootStatusFilter==='all'||(state.shootStatusFilter==='upcoming'&&s.date>=today)||(state.shootStatusFilter==='done'&&s.date<today);
  const items=all.filter(s=>s.date>=from&&s.date<=to&&statusOk(s));
  const filters=[['all','전체'],['upcoming','예정'],['done','완료']].map(([v,l])=>`<button data-act="shoot-status" data-status="${v}" class="${state.shootStatusFilter===v?'is-active':''}">${l}</button>`).join('');
  const columns=dd.map((date,i)=>{const iso=isoDate(date),dayItems=items.filter(s=>s.date===iso);return `<section class="shoot-day-column${state.mobileDay===i?'is-selected':''}"><button class="shoot-day-head" data-act="mobile-day" data-day="${i}"><b>${date.getMonth()+1}.${date.getDate()}</b><span>(${DAYS[i]})</span></button><div>${dayItems.map(s=>{const p=projectOf(s);return `<article class="shoot-board-event" data-act="shoot-edit" data-id="${esc(s.id)}" style="--pc:${p?.color||'#2f80ed'}"><time>${String(s.startH).padStart(2,'0')}:00–${String(s.endH).padStart(2,'0')}:00</time><b>${esc(p?.name||s.title||'촬영')}</b><small>${esc(s.location||'장소 미정')}</small><em>예정</em></article>`}).join('')}<button class="shoot-column-add" data-act="shoot-add" data-date="${iso}"><i class="fa-solid fa-plus"></i> 일정 추가</button></div></section>`}).join('');
  const selectedIso=isoDate(dd[state.mobileDay]);
  const selected=items.filter(s=>s.date===selectedIso);
  const details=selected.map(s=>{const cast=(s.cast||[]).map(x=>x.name).filter(Boolean);return `<button class="shoot-detail-card" data-act="shoot-edit" data-id="${esc(s.id)}"><span class="shoot-detail-thumb"><i class="fa-solid fa-camera"></i></span><span><b>${esc(projectOf(s)?.name||s.title||'촬영')}</b><time>${String(s.startH).padStart(2,'0')}:00–${String(s.endH).padStart(2,'0')}:00</time><small><i class="fa-solid fa-location-dot"></i> ${esc(s.location||'장소 미정')}</small><small><i class="fa-solid fa-user-group"></i> 촬영 ${cast.length}명</small></span><em>예정</em><i class="fa-solid fa-chevron-right"></i></button>`}).join('')||'<p class="shoot-detail-empty">선택한 날짜에 촬영 일정이 없습니다.</p>';
  const castMax=Math.max(0,...items.map(s=>(s.cast||[]).length));
  const hours=items.reduce((n,s)=>n+Math.max(0,+s.endH-+s.startH),0);
  return `<main class="view shoot-view reference-shoot"><header class="view-head"><div class="view-title-row"><div><h1>촬영 일정</h1><p class="sub">씬별 촬영 일정을 관리하고 인원을 배정하세요.</p></div><div class="page-week-nav">${weekNav('sh')}</div><button class="btn-primary shoot-add-primary" data-act="shoot-add"><i class="fa-solid fa-plus"></i> 촬영 일정 추가</button></div></header><div class="reference-shoot-layout"><section class="shoot-board-card"><div class="shoot-status-tabs">${filters}</div><div class="shoot-week-board">${columns}</div></section><aside class="shoot-day-detail"><header><h2>${dd[state.mobileDay].getMonth()+1}. ${dd[state.mobileDay].getDate()} (${DAYS[state.mobileDay]}) 촬영 일정</h2><b>${selected.length}건</b></header>${details}<button class="shoot-detail-add" data-act="shoot-add" data-date="${selectedIso}"><i class="fa-solid fa-plus"></i> 촬영 일정 추가</button></aside></div><section class="shoot-reference-summary"><h2>이번 주 요약</h2><div><article><i class="fa-solid fa-camera"></i><span><small>총 촬영 예정</small><b>${items.length}건</b></span></article><article><i class="fa-solid fa-user-group"></i><span><small>필요 인원 (최대)</small><b>${castMax}명</b></span></article><article><i class="fa-regular fa-clock"></i><span><small>총 촬영 시간</small><b>${hours}시간</b></span></article><article><i class="fa-solid fa-location-dot"></i><span><small>주요 촬영 장소</small><b>${new Set(items.map(s=>s.location).filter(Boolean)).size}곳</b></span></article></div></section></main>`;
}

/* ----- personal view ----- */
function personalCellState(active, day, time) {
  if (!active) return { kind: '', label: '' };
  const shoot = shootBlocksFor(active[0], day).find(b => b.start <= time && b.end > time);
  if (shoot) return { kind: 'has-shoot', label: shoot.label };
  const item = memberWeek(active[0], active[1])?.schedules?.[dates()[day]];
  const explicit = personalRanges(item);
  const classItem = (fixedMap(active[0], active[1])[DAY_KEYS[day]] || []).find(r => +r.start <= time && +r.end > time);
  // 회의·라디오는 개인 '가능'으로도 못 덮음 — 먼저 처리
  if (classItem && isHardBlock(classItem)) return { kind: classItem.path?.includes('라디오방송') ? 'has-radio' : 'has-class', label: classItem.label || '고정 일정' };
  const isAvailable = explicit.available.some(r => +r.start <= time && +r.end >= time + 1);
  const isUnavailable = explicit.unavailable.some(r => +r.start <= time && +r.end >= time + 1);
  if (isAvailable && (classItem || isUnavailable)) return { kind: 'has-personal', label: '가능' };
  if (classItem) return { kind: classItem.path?.includes('라디오방송') ? 'has-radio' : 'has-class', label: classItem.label || '고정 일정' };
  if (isUnavailable) return { kind: 'is-unavailable', label: '불가' };
  return { kind: '', label: '' };
}

function personalWeeklyTable(active) {
  const ds = dates();

  // per-day column of {kind,label} for every hour — then merge vertical runs
  const col = DAYS.map((_, i) => TIMES.map(time => personalCellState(active, i, time)));

  const occupied = Array(DAYS.length).fill(0);
  const rows = TIMES.map((time, ri) => {
    let tds = '';
    for (let i = 0; i < DAYS.length; i++) {
      if (occupied[i] > 0) { occupied[i]--; continue; }
      const c = col[i][ri];
      let span = 1;
      if (c.kind) {
        while (ri + span < TIMES.length && col[i][ri + span].kind === c.kind && col[i][ri + span].label === c.label) span++;
        occupied[i] = span - 1;
      }
      tds += `<td data-act="personal-cell" data-id="${esc(active?.[0] || '')}" data-day="${i}" data-time="${time}"${span > 1 ? ` rowspan="${span}"` : ''} class="${c.kind}" title="${esc(c.label || '기록 없음')}">${esc(c.label)}</td>`;
    }
    return `<tr><th>${String(time).padStart(2, '0')}:00</th>${tds}</tr>`;
  }).join('');

  return `<section class="personal-week-card">
    <div class="personal-week-head">
      <div class="personal-week-title"><span class="personal-week-avatar">${active ? esc(active[1].name?.slice(0, 1)) : '–'}</span><div><h3>${active ? esc(active[1].name) : '인원'}의 주간 일정표</h3><p>직접 등록한 가능·불가능 시간과 반복 수업</p></div></div>
      <div class="personal-week-actions">${weekNav('pe')}<button class="is-secondary" data-act="fixed-open" data-id="${esc(active?.[0] || '')}"><i class="fa-regular fa-calendar-check"></i> 고정 시간표</button><button data-act="personal-cell" data-id="${esc(active?.[0] || '')}"><i class="fa-solid fa-plus"></i> 개인 일정 등록</button></div>
      <div class="personal-week-legend"><span class="legend-class">고정 일정</span><span class="legend-shoot">촬영</span><span class="legend-personal">예외적으로 가능</span><span class="legend-unavailable">개인 불가능</span></div>
    </div>
    <table class="personal-week-table"><thead><tr><th>시간</th>${DAYS.map((d, i) => `<th>${d}<small>${ds[i].split(' ')[1]}</small></th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
  </section>`;
}

function renderPersonal() {
  const people = sortedPeople();
  state.personalActive = Math.max(0, Math.min(state.personalActive, people.length - 1));
  const active = people[state.personalActive];
  const groups = Object.entries(people.reduce((o, p) => { const d = p[1].department || '미지정'; (o[d] ??= []).push(p); return o; }, {}));
  const accordion = `<div class="department-accordion">${groups.map(([dept, its], gi) => `
    <section class="department-slat ${state.personalOpenDepts.has(dept) ? 'is-open' : ''}" style="--slat:${gi}">
      <button class="department-slat-toggle" data-act="department-toggle" data-dept="${esc(dept)}" aria-expanded="${state.personalOpenDepts.has(dept)}"><b>${esc(dept)}</b><span><small>${its.length}명</small><i class="fa-solid fa-chevron-down"></i></span></button>
      <div class="department-people">${its.map(([id, m]) => `<button data-act="person-select" data-i="${people.findIndex(x => x[0] === id)}" class="${id === active?.[0] ? 'active' : ''}"><span>${esc(m.name)}</span><small>${esc(m.department || '미지정')}</small></button>`).join('')}</div>
    </section>`).join('')}</div>`;

  return `<main class="view">
    <header class="view-head">
      <div class="view-title-row"><div><h1>개인 일정 관리</h1><p class="sub">수업 이외의 약속·알바·방송 일정</p></div></div>
    </header>
    <section class="personal-schedule-box">
      <div class="personal-machine">${accordion}</div>
      ${personalWeeklyTable(active)}
    </section>
  </main>`;
}

function renderPersonalReference(){
  const people=sortedPeople();state.personalActive=Math.max(0,Math.min(state.personalActive,people.length-1));const active=people[state.personalActive];
  const fixed=fixedItems(active?.[0],active?.[1]);
  return `<main class="view reference-personal"><header class="view-head"><div class="view-title-row"><div><h1>개인 일정 관리</h1><p class="sub">개인의 수업, 일정, 가능/불가능 시간을 등록하고 관리하세요.</p></div><button class="btn-primary" data-act="personal-cell" data-id="${esc(active?.[0]||'')}" data-day="0" data-time="9"><i class="fa-solid fa-plus"></i> 일정 추가</button></div></header><div class="personal-reference-toolbar"><select data-act="person-select-select">${people.map(([id,m],i)=>`<option value="${i}" ${i===state.personalActive?'selected':''}>${esc(m.name)}</option>`).join('')}</select>${weekNav('pe')}</div><div class="personal-reference-layout"><section class="personal-reference-calendar">${personalWeeklyTable(active)}</section><aside class="personal-reference-side"><section><h2>${esc(active?.[1]?.name||'인원')}의 정보</h2><dl><div><dt><i class="fa-solid fa-user-group"></i> 부서</dt><dd>${esc(active?.[1]?.department||'미지정')}</dd></div><div><dt><i class="fa-solid fa-graduation-cap"></i> 고정 수업</dt><dd>${fixed.length}개</dd></div><div><dt><i class="fa-regular fa-calendar"></i> 기준 주</dt><dd>${esc(weekLabel())}</dd></div></dl></section><section class="personal-side-add"><header><h2>일정 추가</h2><button data-act="fixed-open" data-id="${esc(active?.[0]||'')}">고정 수업 관리</button></header><div class="personal-type-tabs"><b>수업</b><span>가능</span><span>불가능</span><span>기타</span></div><button class="personal-add-large" data-act="personal-cell" data-id="${esc(active?.[0]||'')}" data-day="0" data-time="9"><i class="fa-solid fa-plus"></i> 새 일정 등록하기</button></section></aside></div><section class="personal-quick-row"><article><h3>빠른 설정</h3><button data-act="personal-cell" data-id="${esc(active?.[0]||'')}" data-day="0" data-time="9">이번 주 일정 관리</button></article><article><h3>반복 등록</h3><button data-act="fixed-open" data-id="${esc(active?.[0]||'')}">여러 주 반복 일정 등록</button></article><article><h3>고정 수업 시간 관리</h3><button data-act="fixed-open" data-id="${esc(active?.[0]||'')}">수업 시간 설정</button></article></section></main>`;
}

/* ----- mobile home ----- */
function renderMobileHome() {
  const dd = Array.from({ length: 7 }, (_, i) => dayDate(i));
  const allShoots = shootDisplayGroups(Object.entries(shoots).map(([id, s]) => ({ id, ...s })));
  const todayIso = isoDate(new Date());
  const todayShoots = allShoots.filter(s => s.date === todayIso).sort((a, b) => +a.startH - +b.startH);
  const dateLabel = `${dd[0].getFullYear()}년 ${dd[0].getMonth() + 1}월 ${dd[0].getDate()}일 (${DAYS[0]}) ~ ${dd[6].getMonth() + 1}월 ${dd[6].getDate()}일 (${DAYS[6]})`;
  const dayTiles = dd.map((date, i) => {
    const count = allShoots.filter(s => s.date === isoDate(date)).length;
    const isToday = isoDate(date) === todayIso;
    return `<div class="mobile-day${isToday ? ' is-today' : ''}"><b>${date.getMonth() + 1}.${date.getDate()}</b><span>${DAYS[i]}</span><em>${count}건</em></div>`;
  }).join('');
  const weekStartIso = isoDate(dd[0]), weekEndIso = isoDate(dd[6]);
  const weekShootList = allShoots.filter(s => s.date >= weekStartIso && s.date <= weekEndIso).sort((a,b) => String(a.date).localeCompare(String(b.date)) || +a.startH - +b.startH).slice(0, 4).map(s => {
    const project = projectOf(s);
    return `<button class="mobile-week-shoot" data-act="shoot-edit" data-id="${esc(s.id)}" style="--pc:${project?.color || '#e6537c'}"><i></i><span><small>${fmtShootDate(s.date)}</small><b>${esc(s.title || '촬영')}</b></span><em>${String(s.startH).padStart(2,'0')}:00</em></button>`;
  }).join('');
  const registeredShoots = allShoots.filter(s => { const d = new Date(`${s.date}T00:00`); const start = dd[0], end = dd[6]; return !isNaN(d) && d >= new Date(start.getFullYear(), start.getMonth(), start.getDate()) && d <= new Date(end.getFullYear(), end.getMonth(), end.getDate()); }).sort((a, b) => String(a.date).localeCompare(String(b.date)) || +a.startH - +b.startH);
  const registeredGroups = [...registeredShoots.reduce((groups, shoot) => {
    const key = `${shoot.date}::${shoot.projectId || shoot.title || '촬영'}`;
    if (!groups.has(key)) groups.set(key, {
      date: shoot.date,
      projectId: shoot.projectId || '',
      title: projectOf(shoot)?.name || shoot.title || '촬영',
      color: projectOf(shoot)?.color || '#e6537c',
      items: [],
    });
    groups.get(key).items.push(shoot);
    return groups;
  }, new Map()).values()];
  const todayList = registeredGroups.length ? registeredGroups.map(group => `<article class="mobile-registered-group" style="--pc:${group.color}">
    <header><i></i><span><b>${fmtShootDate(group.date)} · ${esc(group.title)}</b><small>${group.items.length}개 일정</small></span></header>
    <div>${group.items.map(s => `<button data-act="shoot-edit" data-id="${esc(s.id)}"><b>${String(s.startH).padStart(2, '0')}:00–${String(s.endH).padStart(2, '0')}:00</b><small>${s.location ? esc(s.location) : '장소 미정'}</small><i class="fa-solid fa-chevron-right"></i></button>`).join('')}</div>
  </article>`).join('') : '<div class="mobile-card-empty">이번 주 등록된 촬영 일정이 없습니다.</div>';
  const memberCount = Object.keys(base).length;
  const weekShootCount = registeredShoots.length;
  const analyzedCount = Object.values(projects).filter(p => p?.aiAnalysis?.job || p?.aiAnalysis?.analysisJobs).length;
  const upcoming = registeredGroups.slice(0, 3).map(group => `<article class="mobile-upcoming-row"><time>${fmtShootDate(group.date).replace('요일','')}</time><i class="fa-solid fa-camera"></i><span><b>${esc(group.title)}</b><small>${group.items.map(s => `${String(s.startH).padStart(2,'0')}:00–${String(s.endH).padStart(2,'0')}:00`).join(' · ')}</small></span><button data-act="tab" data-tab="shoot" aria-label="촬영 일정 열기"><i class="fa-solid fa-chevron-right"></i></button></article>`).join('');
  return `<main class="mobile-home">
    <div class="mobile-home-body">
      <header class="mobile-brand-head"><div class="mobile-brand-lockup"><span class="hn-wave"><i></i><i></i><i></i><i></i><i></i></span><span><b>HNUBS</b><small>방송국 스케줄러</small></span></div><div class="mobile-head-tools"><time>${new Date().getMonth()+1}월 ${new Date().getDate()}일 (${DAYS[(new Date().getDay()+6)%7]})</time><button data-act="tab" data-tab="settings" aria-label="설정"><i class="fa-solid fa-gear"></i></button></div></header>
      <section class="mobile-dashboard-card mobile-today-card"><header><h2>오늘의 일정</h2><button data-act="tab" data-tab="shoot">전체 보기 <i class="fa-solid fa-chevron-right"></i></button></header><div>${todayShoots.map(s=>`<button data-act="shoot-edit" data-id="${esc(s.id)}"><i class="fa-solid fa-camera"></i><span><b>${esc(projectOf(s)?.name||s.title||'촬영')}</b><small>${String(s.startH).padStart(2,'0')}:00–${String(s.endH).padStart(2,'0')}:00${s.location?' · '+esc(s.location):''}</small></span><em>예정</em><i class="fa-solid fa-chevron-right"></i></button>`).join('')||'<p>오늘 등록된 일정이 없습니다.</p>'}</div></section>
      <section class="mobile-quick-links">
        <button data-act="tab" data-tab="week"><i class="fa-regular fa-calendar" style="--ic:#3182d7;--ib:#edf5ff"></i><b>주간 일정</b></button>
        <button data-act="tab" data-tab="shoot"><i class="fa-solid fa-camera" style="--ic:#e6537c;--ib:#fff0f5"></i><b>촬영 일정</b></button>
        <button data-act="tab" data-tab="ai"><i class="fa-solid fa-wand-magic-sparkles" style="--ic:#874de0;--ib:#f5efff"></i><b>AI 분석</b></button>
        <button data-act="tab" data-tab="personal"><i class="fa-regular fa-user" style="--ic:#ef6887;--ib:#fff0f4"></i><b>개인 일정</b></button>
      </section>
      <section class="mobile-dashboard-card mobile-stats-card"><header><h2>이번 주 현황</h2><button data-act="tab" data-tab="week">자세히 보기 <i class="fa-solid fa-chevron-right"></i></button></header><div><article><i class="fa-solid fa-user-group"></i><span><b>${memberCount}명</b><small>등록 인원</small></span></article><article><i class="fa-regular fa-clock"></i><span><b>${Math.round(avgAvailabilityHours())}시간</b><small>총 가능 시간</small></span></article><article><i class="fa-solid fa-camera"></i><span><b>${weekShootCount}건</b><small>예정된 촬영</small></span></article><article><i class="fa-solid fa-circle-check"></i><span><b>${analyzedCount}건</b><small>분석 완료</small></span></article></div></section>
      <section class="mobile-dashboard-card mobile-upcoming-card"><header><h2>다가올 일정</h2><button data-act="tab" data-tab="shoot">전체 보기 <i class="fa-solid fa-chevron-right"></i></button></header>${upcoming||'<p class="mobile-card-empty">이번 주 등록된 촬영 일정이 없습니다.</p>'}</section>
    </div>
  </main>`;
}

/* ----- mobile tab views ----- */
function avgAvailabilityHours(){return TIMES.reduce((n,t)=>n+DAYS.filter((_,d)=>info(d,t).yes.length>0).length,0)}
const mobileBrand = () => `<div class="mobile-brand-lockup"><span class="hn-wave"><i></i><i></i><i></i><i></i><i></i></span><span><b>HNUBS</b><small>방송국 스케줄러</small></span></div>`;
const mobileHead = (title, sub='') => `<header class="mobile-screen-head"><div>${mobileBrand()}<h1>${esc(title)}</h1><p>${esc(sub)}</p></div></header>`;
const mobileDayStrip = () => `<div class="mobile-day-strip">${DAYS.map((d,i)=>{const x=dayDate(i);return `<button data-act="mobile-day" data-day="${i}" class="${state.mobileDay===i?'is-active':''}"><b>${x.getMonth()+1}.${x.getDate()}</b><span>${d}</span></button>`}).join('')}</div>`;
function renderMobileWeek(){
  const d=state.mobileDay;
  const cards=DAYS.map((day,i)=>{const slots=TIMES.map(t=>info(i,t));const best=slots.reduce((a,b)=>!a||b.yes.length>a.yes.length?b:a,null);const full=slots.filter(s=>s.yes.length===Object.keys(base).length);return `<button class="mobile-week-summary${d===i?' is-active':''}" data-act="mobile-week-open" data-day="${i}"><span><b>${day}요일</b><small>${dates()[i].match(/\d+월 \d+일/)?.[0]||''}</small></span><strong>${best?.yes.length||0}명</strong><em>${full.length?`${full[0].time}:00 전원 가능`:`가장 여유로운 시간 ${best?.time||'-'}:00`}</em><i class="fa-solid fa-chevron-right"></i></button>`}).join('');
  const timeline=TIMES.map(t=>{const s=info(d,t);return `<button class="mobile-week-slot" data-act="slot" data-day="${d}" data-time="${t}"><time>${String(t).padStart(2,'0')}:00</time><span><i style="width:${Math.round((s.yes.length/Math.max(1,Object.keys(base).length))*100)}%"></i></span><b>${s.yes.length}명</b></button>`}).join('');
  return `<main class="mobile-screen mobile-week-screen" data-mobile-view="week">${mobileHead('주간 일정','날짜별 촬영 가능 인원을 확인하세요.')}<div class="mobile-month-nav"><button data-act="wk-prev"><i class="fa-solid fa-chevron-left"></i></button><b>${esc(weekLabel())}</b><button data-act="wk-next"><i class="fa-solid fa-chevron-right"></i></button></div>${state.mobileWeekDetail?`<section class="mobile-screen-card mobile-week-detail"><header><button data-act="mobile-week-back"><i class="fa-solid fa-chevron-left"></i> 주간 요약</button><div><b>${DAYS[d]}요일</b><small>${dates()[d]}</small></div></header><div>${timeline}</div></section>`:`<section class="mobile-week-summary-list">${cards}</section>`}</main>`}
function renderMobileAnalysis(){const list=TIMES.flatMap(t=>DAYS.map((_,d)=>info(d,t))).sort((a,b)=>b.yes.length-a.yes.length).slice(0,12);return `<main class="mobile-screen" data-mobile-view="analysis">${mobileHead('시간 분석','촬영 가능한 시간 추천')}<section class="mobile-screen-card"><h2>추천 시간대</h2><div class="mobile-analysis-list">${list.map(s=>`<button class="mobile-analysis-card" data-act="aslot" data-day="${s.day}" data-time="${s.time}"><b>${DAYS[s.day]} ${s.time}:00–${s.time+1}:00</b><strong>${s.yes.length}명</strong></button>`).join('')}</div><button class="mobile-wide-action" data-act="quick" data-quick="filter">인원 다시 선택</button></section></main>`}
function renderMobileShoot(){
  const d=state.mobileDay, iso=isoDate(dayDate(d));
  const all=shootDisplayGroups(Object.entries(shoots).map(([id,s])=>({id,...s})));
  const items=all.filter(s=>s.date===iso).sort((a,b)=>+a.startH-+b.startH);
  const modes=[['day','일간'],['week','주간'],['month','월간'],['list','목록']].map(([id,label])=>`<button data-act="mobile-shoot-mode" data-mode="${id}" class="${state.mobileShootMode===id?'is-active':''}">${label}</button>`).join('');
  const month=dayDate(d).getMonth()+1;
  let content='';
  if(state.mobileShootMode==='day'){
    const events=items.map(s=>{const p=projectOf(s), expanded=state.mobileShootExpanded===s.id; const cast=(s.cast||[]).map(x=>x.name).filter(Boolean);return `<article class="mobile-timeline-event${expanded?' is-expanded':''}" data-act="mobile-shoot-expand" data-id="${esc(s.id)}" style="--top:${(Math.max(9,+s.startH)-9)*58}px;--height:${Math.max(52,(Math.min(23,+s.endH)-Math.max(9,+s.startH))*58-6)}px;--pc:${p?.color||'#2f80ed'}"><i class="fa-solid fa-camera"></i><span><b>${esc(p?.name||s.title||'촬영')}</b><small>${String(Math.max(9,+s.startH)).padStart(2,'0')}:00–${String(s.endH).padStart(2,'0')}:00${s.location?' · '+esc(s.location):''}</small>${expanded?`<em>${cast.length?'참여 '+esc(cast.join(', ')):'등록된 인원 없음'}</em>`:''}</span><button data-act="shoot-edit" data-id="${esc(s.id)}" aria-label="일정 수정"><i class="fa-solid fa-ellipsis-vertical"></i></button></article>`}).join('');
    content=`<section class="mobile-day-timeline"><header><h2>${month}월 ${dayDate(d).getDate()}일 (${DAYS[d]})</h2><button data-act="mobile-day" data-day="${Math.max(0,Math.min(6,(new Date().getDay()+6)%7))}">오늘</button></header><div class="mobile-timeline-grid"><div class="mobile-time-axis">${TIMES.map(t=>`<span>${String(t).padStart(2,'0')}:00</span>`).join('')}</div><div class="mobile-time-track">${TIMES.map(()=>'<i></i>').join('')}${events}</div></div></section>`;
  }else{
    const list=state.mobileShootMode==='month'?all.filter(s=>new Date(`${s.date}T00:00`).getMonth()+1===month):all.filter(s=>s.date>=isoDate(dayDate(0))&&s.date<=isoDate(dayDate(6)));
    content=`<section class="mobile-shoot-list-view">${list.map(s=>`<button data-act="shoot-edit" data-id="${esc(s.id)}"><time>${fmtShootDate(s.date)}</time><span><b>${esc(projectOf(s)?.name||s.title||'촬영')}</b><small>${String(s.startH).padStart(2,'0')}:00–${String(s.endH).padStart(2,'0')}:00${s.location?' · '+esc(s.location):''}</small></span><i class="fa-solid fa-chevron-right"></i></button>`).join('')||'<p>등록된 촬영 일정이 없습니다.</p>'}</section>`;
  }
  return `<main class="mobile-screen mobile-shoot-screen" data-mobile-view="shoot">${mobileHead('촬영 일정','촬영 일정을 한눈에 확인하세요.')}<div class="mobile-month-nav"><button data-act="sh-prev"><i class="fa-solid fa-chevron-left"></i></button><b>${dayDate(d).getFullYear()}년 ${month}월</b><button data-act="sh-next"><i class="fa-solid fa-chevron-right"></i></button></div><div class="mobile-view-modes">${modes}</div>${mobileDayStrip()}${content}<button class="mobile-fab" data-act="shoot-add" data-date="${iso}" data-start="18" data-end="19"><i class="fa-solid fa-plus"></i><span>일정 추가</span></button></main>`;
}
function renderMobilePersonal(){
  const people=sortedPeople();const active=people[state.personalActive];const d=state.mobileDay;
  return `<main class="mobile-screen mobile-personal-screen" data-mobile-view="personal">${mobileHead('개인 일정','나의 일정을 시간표로 확인하고 관리하세요.')}<div class="mobile-month-nav"><button data-act="pe-prev"><i class="fa-solid fa-chevron-left"></i></button><b>${dayDate(d).getFullYear()}년 ${dayDate(d).getMonth()+1}월</b><button data-act="pe-next"><i class="fa-solid fa-chevron-right"></i></button></div><section class="mobile-screen-card"><div class="mobile-personal-toolbar"><div class="mobile-person-chips">${people.map(([id,m],i)=>`<button data-act="person-select" data-i="${i}" class="${i===state.personalActive?'is-active':''}">${esc(m.name)}</button>`).join('')}</div><button data-act="personal-cell" data-id="${esc(active?.[0]||'')}" data-day="${d}" data-time="9"><i class="fa-solid fa-plus"></i> 일정 추가</button></div>${mobileDayStrip()}<h2>${active?esc(active[1].name):'인원'}의 주간 시간표</h2><div class="mobile-personal-table">${personalWeeklyTable(active)}</div></section><section class="mobile-personal-legend"><h2>일정 분류</h2><div><span><i class="purple"></i>수업</span><span><i class="green"></i>가능</span><span><i class="pink"></i>촬영</span><span><i class="blue"></i>방송국</span><span><i class="yellow"></i>개인</span></div></section></main>`;
}
function renderMobileAI(){
  const pid=aiProjectId(), saved=projects[pid]?.aiAnalysis||{}, job=aiCurrentJob();
  const scenes=job?.scenes||saved.scenes||[];
  const serverLogs=(job?.logs||[]).slice(-8).reverse();
  state.aiSceneIndex=Math.max(0,Math.min(state.aiSceneIndex,Math.max(0,scenes.length-1)));
  const scene=scenes[state.aiSceneIndex]||null, progress=job?.status==='completed'?100:(job?.progress||0);
  const candidates=aiCandidates(scene?[scene]:[]);
  const connected=!!aiState.health?.configured;
  const projectOpts=Object.entries(projects).sort(([,a],[,b])=>(a.createdAt||0)-(b.createdAt||0)).map(([id,p])=>`<option value="${esc(id)}" ${id===pid?'selected':''}>${esc(p.name)}</option>`).join('');
  const candidateRows=candidates.items.slice(0,5).map((slot,i)=>`<button data-act="ai-candidate" data-day="${slot.day}" data-time="${slot.time}"><i>${i+1}</i><span><b>${DAYS[slot.day]}요일 ${String(slot.time).padStart(2,'0')}:00–${String(slot.time+1).padStart(2,'0')}:00</b><small>${scene?.sceneId?`${esc(scene.sceneId)} · `:''}${slot.yes.map(x=>esc(base[x]?.name||'')).filter(Boolean).slice(0,3).join(', ')||'가능 인원 없음'}</small></span><em>${slot.yes.length}명 가능</em><i class="fa-solid fa-chevron-right"></i></button>`).join('');
  const sceneRows=scenes.slice(0,6).map((item,i)=>`<button data-act="ai-scene" data-i="${i}" class="${i===state.aiSceneIndex?'is-active':''}"><span><b>${esc(item.sceneId||`S#${i+1}`)}</b><small>${esc(item.location||item.title||'장소 미정')}</small></span><i class="fa-solid fa-chevron-right"></i></button>`).join('');
  const running=['queued','running','partial'].includes(job?.status), completed=job?.status==='completed';
  return `<main class="mobile-screen mobile-ai-screen" data-mobile-view="ai">
    ${mobileHead('AI 분석','대본을 분석하고 촬영 후보를 추천합니다.')}
    <section class="mobile-ai-command"><div><i class="fa-solid fa-wand-magic-sparkles"></i><span><b>${scene?`${esc(scene.sceneId||'선택한 씬')} 촬영 가능한 시간 알려줘`:'대본을 선택해 촬영 가능한 시간을 찾아보세요'}</b><small>씬·장소·등장 배역과 실제 일정을 함께 분석합니다.</small></span></div><button data-act="ai-file" aria-label="대본 선택"><i class="fa-solid fa-arrow-right"></i></button></section>
    <div class="mobile-ai-shortcuts"><button data-act="tab" data-tab="analysis"><i class="fa-regular fa-calendar-check"></i><span><b>공통 가능 시간</b><small>여러 명의 시간을 비교</small></span></button><button data-act="quick" data-quick="filter"><i class="fa-solid fa-user-group"></i><span><b>촬영 인원 추천</b><small>씬에 맞는 인원 확인</small></span></button><button data-act="tab" data-tab="week"><i class="fa-solid fa-chart-column"></i><span><b>일정 최적화</b><small>이번 주 시간표 분석</small></span></button><button data-act="ai-file"><i class="fa-solid fa-file-lines"></i><span><b>대본 분석</b><small>씬과 등장 배역 분류</small></span></button></div>
    <section class="mobile-screen-card mobile-ai-upload"><header><div><h2>대본 분석</h2><p>PDF · DOCX · TXT, 최대 20MB</p></div><button data-act="ai-reset" ${!job?'disabled':''}>초기화</button></header><label>프로젝트<select data-act="ai-project">${projectOpts||'<option value="">프로젝트 없음</option>'}</select></label><button class="mobile-ai-file" data-act="ai-file"><i class="fa-solid fa-cloud-arrow-up"></i><span><b>${aiState.file?esc(aiState.file.name):'대본 파일을 선택하세요'}</b><small>${aiState.extractedText?`${aiState.extractedText.length.toLocaleString()}자 추출 완료`:'파일 선택 또는 드래그 앤 드롭'}</small></span></button><button class="mobile-ai-start" data-act="ai-start" ${!pid||!aiState.extractedText||!connected||running?'disabled':''}><i class="fa-solid fa-play"></i> 분석 시작하기</button></section>
    <section class="mobile-screen-card mobile-ai-progress ${running?'is-running':''}"><header><span><i class="fa-solid ${completed?'fa-circle-check':'fa-wand-magic-sparkles'}"></i><b>${completed?'분석이 완료되었어요!':running?'AI가 분석 중이에요…':'분석 진행 상황'}</b></span><strong>${progress}%</strong></header><div class="mobile-ai-progressbar"><i style="width:${progress}%"></i></div><div class="mobile-ai-steps"><span class="${progress>0?'done':''}">파일 읽기</span><span class="${progress>=35?'done':''}">씬 분석</span><span class="${progress>=70?'done':''}">일정 계산</span><span class="${progress===100?'done':''}">결과 정리</span></div></section>
    <section class="mobile-screen-card mobile-ai-server-log"><header><h2>서버 로그</h2><small>실시간 업데이트</small></header><ul aria-live="polite">${serverLogs.map(entry=>`<li><time>${esc(entry.time||'--:--:--')}</time><span class="${esc(entry.level||'info')}">${esc(entry.level||'info')}</span><b>${esc(entry.message||'')}</b></li>`).join('')||'<li class="is-empty">분석을 시작하면 서버 로그가 표시됩니다.</li>'}</ul></section>
    ${scenes.length?`<section class="mobile-screen-card mobile-ai-scenes"><header><h2>분석된 씬</h2><small>${scenes.length}개</small></header><div>${sceneRows}</div></section>`:''}
    <section class="mobile-screen-card mobile-ai-candidates"><header><h2>추천 촬영 가능 시간</h2><button data-act="tab" data-tab="analysis">전체 보기 <i class="fa-solid fa-chevron-right"></i></button></header><div>${candidateRows||'<p>분석할 씬을 선택하면 실제 시간표 기준 후보가 표시됩니다.</p>'}</div></section>
  </main>`;
}
function renderMobileSettings(){const groups=Object.entries(sortedPeople().reduce((o,p)=>{const d=p[1].department||'미지정';(o[d]??=[]).push(p);return o},{}));return `<main class="mobile-screen" data-mobile-view="settings">${mobileHead('설정','인원·고정 시간표·방송 관리')}<section class="mobile-screen-card mobile-settings-actions"><button data-act="member-add"><i class="fa-solid fa-user-plus"></i> 인원 추가</button><button data-act="radio-open"><i class="fa-solid fa-microphone-lines"></i> 라디오 방송 담당</button></section><section class="mobile-screen-card">${groups.map(([d,its])=>`<div class="mobile-member-group"><h2>${esc(d)}</h2>${its.map(([id,m])=>`<article class="mobile-member-card"><b>${esc(m.name)}</b><small>${fixedItems(id,m).length}개 고정 일정</small><button data-act="fixed-open" data-id="${esc(id)}">관리</button></article>`).join('')}</div>`).join('')}</section></main>`}

/* ----- NVIDIA NIM script analysis ----- */
function aiProjectId() {
  const ids = Object.keys(projects);
  if (!state.aiProjectId || !projects[state.aiProjectId]) state.aiProjectId = ids[0] || '';
  return state.aiProjectId;
}

function aiCurrentJob() {
  const pid = aiProjectId();
  if (aiState.job?.projectId === pid) return aiState.job;
  const saved = projects[pid]?.aiAnalysis || {};
  return saved.job || saved.analysisJobs?.[saved.activeJobId] || null;
}

function aiCharacters(scenes = []) {
  const values = scenes.flatMap(scene => [scene.characters, scene.speakingCharacters, scene.backgroundCharacters].flatMap(x => Array.isArray(x) ? x : []));
  return [...new Set(values.map(x => String(x || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
}

function sceneRequiredCharacters(scene) {
  const speaking = Array.isArray(scene?.speakingCharacters) ? scene.speakingCharacters : [];
  const fallback = Array.isArray(scene?.characters) ? scene.characters : [];
  return [...new Set((speaking.length ? speaking : fallback).map(x => String(x || '').trim()).filter(Boolean))];
}

/** 모든 씬에 기획·촬영 담당이 반드시 필요하다.
 *  프로젝트 지정값이 있으면 AI 출력보다 우선한다. 모델이 뒤쪽 씬에서 다른 이름을 만들면 안 된다. */
function sceneCrewNames(scene, projectId) {
  const pick = v => (Array.isArray(v) ? v : []).map(x => String(x?.name || x || '').trim()).filter(Boolean);
  const roles = projectRoles(projects[projectId] || {});
  const assigned = [...pick(roles.planning), ...pick(roles.production)];
  const fallback = [...pick(scene?.crew?.planning), ...pick(scene?.crew?.production)];
  return [...new Set(assigned.length ? assigned : fallback)];
}

function applyAutoCastMappings(job) {
  const next = { ...(projects[aiProjectId()]?.aiAnalysis?.characterMappings || {}), ...aiState.mappings };
  const members = sortedPeople().map(([id, member]) => ({ id, name: String(member.name || '').trim(), key: String(member.name || '').replace(/\s+/g, '') }));
  for (const item of Array.isArray(job?.castMappings) ? job.castMappings : []) {
    const character = String(item?.character || '').trim(), person = String(item?.person || '').trim();
    if (!character || !person || next[character]) continue;
    const personKey = person.replace(/\s+/g, '');
    const matched = members.find(member => member.name === person) || members.find(member => member.key && personKey.includes(member.key));
    if (matched) next[character] = matched.id;
  }
  for (const character of aiCharacters(job?.scenes || [])) {
    if (next[character]) continue;
    const key = character.replace(/\s+/g, '');
    const matched = members.find(member => member.name === character || member.key === key);
    if (matched) next[character] = matched.id;
  }
  aiState.mappings = next;
}

/** 배역 이름 -> 등록 인원 ID.
 *  연결된 매핑이 먼저고, 없으면 이름이 같은 인원으로 본다.
 *  이 함수 하나만 쓰도록 해야 화면마다 다른 사람이 잡히는 일이 없다. */
function resolveMemberId(name) {
  const mappings = { ...(projects[aiProjectId()]?.aiAnalysis?.characterMappings || {}), ...aiState.mappings };
  const key = String(name || '').trim();
  if (mappings[key] && base[mappings[key]]) return mappings[key];
  const found = Object.entries(base).find(([, m]) => String(m.name || '').trim() === key);
  return found ? found[0] : '';
}

/** 후보를 찾을 날짜 목록.
 *  범위를 지정하지 않으면 지금 보고 있는 주 7일만 본다. */
function planDates() {
  const plan = aiState.planOptions || {};
  const from = String(plan.dateFrom || '').trim(), to = String(plan.dateTo || '').trim();
  const start = new Date(`${from}T12:00:00`), end = new Date(`${to}T12:00:00`);
  if (!from || !to || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    return DAYS.map((_, dayIndex) => ({ iso: isoDate(dayDate(dayIndex)), dayIndex }));
  }
  const out = [];
  for (const cursor = new Date(start); cursor <= end && out.length < 120; cursor.setDate(cursor.getDate() + 1)) {
    out.push({ iso: isoDate(new Date(cursor)), dayIndex: (cursor.getDay() + 6) % 7 });
  }
  return out;
}

/* ── 촬영 일정 코파일럿 ─────────────────────────────────────
   사람이 날짜를 고르면 그날 찍을 수 있는 씬을 판정만 해 준다.
   배치는 하지 않는다 — 일정표에 넣는 건 사람이 한다.

   촬영 사이 준비시간은 고정값을 쓴다. 장소별 이동시간 데이터가
   없으므로 거리를 추정하지 않는다. 설정에서 조정한다. */
const shootGapHours = () => Math.max(0, (Number(appSettings.shootGapMinutes) || 30) / 60);

/** 그 날짜에 씬을 찍을 수 있는지 판정한다. 추천 / 가능 / 조건부 / 불가. */
function copilotForDate(iso) {
  const job = aiCurrentJob();
  const scenes = job?.scenes || [];
  const pid = aiProjectId();
  if (!scenes.length || !/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return { date: iso, scenes: [] };

  const crewIds = [...new Set(scenes.flatMap(s => sceneCrewNames(s, pid)).map(resolveMemberId).filter(id => base[id]))];

  // 그날 이미 잡힌 촬영. 모든 프로젝트를 본다 — 남의 프로젝트가 사람을 데려간다.
  const dayShoots = Object.entries(shoots)
    .filter(([, s]) => s && s.date === iso)
    .map(([id, s]) => ({ id, ...s, ids: shootMemberIds(s) }));
  // 그날 이 프로젝트로 이미 나오는 사람 = 또 부르지 않아도 되는 사람
  const alreadyHere = new Set();
  for (const s of dayShoots) if (s.projectId === pid) for (const x of s.ids) alreadyHere.add(x);
  // 이미 촬영으로 확정된 씬은 다시 권하지 않는다
  const done = new Set(dayShoots.flatMap(s => (Array.isArray(s.sceneIds) ? s.sceneIds : []).map(String)));
  const placeToday = dayShoots.filter(s => s.projectId === pid && String(s.location || '').trim());
  // 다른 프로젝트가 쓰는 장소. 같은 시간에 두 팀이 한 곳을 쓸 수는 없다.
  const otherPlaces = dayShoots.filter(s => s.projectId !== pid && String(s.location || '').trim());

  const gap = shootGapHours();
  const plan = aiState.planOptions || {};
  const dayStart = Number(plan.dayStart) || 18, dayEnd = Number(plan.dayEnd) || 23;
  const who = id => members()[id];
  const freeIn = (member, a, b) => rangesOn(member, iso).some(r => +r.start <= a && +r.end >= b);

  const out = [];
  for (const [index, scene] of scenes.entries()) {
    const id = String(scene.sceneId || `S#${index + 1}`);
    const castIds = [...new Set(sceneRequiredCharacters(scene).map(resolveMemberId).filter(x => base[x]))];
    const need = [...new Set([...castIds, ...crewIds])];
    const hours = Math.max(.5, sceneMinutes(scene) / 60);
    const location = String(scene.location || '').trim();
    const names = list => list.map(x => base[x]?.name || '').filter(Boolean);

    if (done.has(id)) continue;                       // 이미 찍기로 한 씬
    if (!need.length) {
      out.push({ id, level: '불가', location, people: [], castIds: [], start: null, minutes: Math.round(hours * 60),
        reason: '이 씬에 배정된 인원이 없습니다. 배역을 인원과 연결해 주세요.', blockedNames: [] });
      continue;
    }

    /* rangesOn 이 이미 촬영·수업을 빼고 준다. 전원이 비는 가장 이른 시각을 찾는다.
       candidateStarts 는 30분 눈금에 실제 가능 경계를 더해 준다 — 18:35 도 후보가 된다. */
    const windows = need.map(x => ({ from: 0, to: hours, ranges: rangesOn(who(x), iso) }));
    /* 장소를 두 팀이 동시에 쓸 수는 없다. 다른 프로젝트가 같은 곳을 쓰는 시간은 후보에서 뺀다. */
    const placeBusy = (a, b) => !!location && otherPlaces.some(s =>
      locationAffinity(scene, { location: s.location }) > 0 && a < +s.endH && b > +s.startH);
    const okAt = time => !placeBusy(time, time + hours) && need.every(x => freeIn(who(x), time, time + hours));
    const allStarts = candidateStarts({ totalHours: hours, windows, dayStart, dayEnd }).filter(okAt);
    const free = allStarts[0];

    if (free === undefined || free === null) {
      // 왜 안 되는지 구분해 준다. '시간이 없다'와 '남이 데려갔다'는 다른 문제다.
      const taken = need.filter(x => dayShoots.some(s => s.projectId !== pid && s.ids.has(x)));
      const placeHeld = otherPlaces.find(s => locationAffinity(scene, { location: s.location }) > 0);
      out.push({ id, level: '불가', location, people: names(castIds), castIds, start: null, minutes: Math.round(hours * 60),
        blockedNames: names(taken),
        reason: taken.length
          ? `${names(taken).join(', ')} · 다른 프로젝트 촬영과 겹칩니다.`
          : placeHeld
            ? `${placeHeld.location} · 다른 프로젝트가 이미 쓰는 장소입니다.`
            : `${hourText(dayStart)}~${hourText(dayEnd)} 안에 출연진 공통 가능 시간이 없습니다.` });
      continue;
    }

    // 앞 촬영과 너무 붙어 있으면 '조건부'. 준비시간이 안 나온다.
    const tight = dayShoots.filter(s => need.some(x => s.ids.has(x))
      && +s.endH <= free && free - +s.endH < gap);
    const overlapPeople = names([...new Set(tight.flatMap(s => need.filter(x => s.ids.has(x))))]);
    const sharesPeople = need.some(x => alreadyHere.has(x));
    // 정확히 같은 글자가 아니라 겹치는 낱말로 본다. "N5동 복도"와 "N5동 강의실"은 같은 건물이다.
    const nearPlace = placeToday.find(s => locationAffinity(scene, { location: s.location }) > 0);
    const samePlace = !!location && !!nearPlace;

    const level = tight.length ? '조건부' : (sharesPeople || samePlace) ? '추천' : '가능';
    const reasonParts = [];
    if (tight.length) reasonParts.push(`${overlapPeople.join(', ')} 직전 촬영이 ${hourText(tight[0].endH)}에 끝납니다 · 준비시간 ${Math.round(gap * 60)}분 확보 권장`);
    if (sharesPeople) reasonParts.push(`${names(need.filter(x => alreadyHere.has(x))).join(', ')} 이 날 이미 촬영합니다`);
    if (samePlace) reasonParts.push(`${nearPlace.location} 촬영이 이 날 이미 있습니다`);
    if (!reasonParts.length) reasonParts.push(crewIds.length
      ? `출연 ${names(castIds).length}명 + 스태프 ${crewIds.length}명 전원 가능`
      : `출연 ${names(castIds).length}명 전원 가능`);

    const from = tight.length ? Math.max(free, +tight[0].endH + gap) : free;
    out.push({ id, level, location, people: names(castIds), castIds, minutes: Math.round(hours * 60),
      start: from,
      // 고를 수 있게 후보를 몇 개 준다. 권장 시작 이후로만.
      starts: allStarts.filter(v => v >= from).slice(0, 3),
      hours,
      sharesPeople, samePlace, blockedNames: [],
      reason: reasonParts.join(' · ') });
  }

  /* 정렬: 추천도 -> 같은 배우가 이미 촬영 -> 같은 장소 -> 이른 시간 -> 씬 번호 */
  const rank = { '추천': 0, '가능': 1, '조건부': 2, '불가': 3 };
  const no = v => Number(String(v).match(/\d+/)?.[0] || 999);
  out.sort((a, b) => rank[a.level] - rank[b.level]
    || (b.sharesPeople ? 1 : 0) - (a.sharesPeople ? 1 : 0)
    || (b.samePlace ? 1 : 0) - (a.samePlace ? 1 : 0)
    || (a.start ?? 99) - (b.start ?? 99)
    || no(a.id) - no(b.id));
  const timeline = dayShoots
    .map(s => ({ title: s.title || '촬영', startH: +s.startH, endH: +s.endH,
      mine: s.projectId === pid, location: String(s.location || ''),
      people: [...s.ids].map(x => base[x]?.name || '').filter(Boolean) }))
    .sort((a, b) => a.startH - b.startH);
  return { date: iso, gapMinutes: Math.round(gap * 60), dayStart, dayEnd, timeline,
    // 기획·촬영 담당도 필수 인원이다. 화면에 안 보이면 왜 막혔는지 알 수가 없다.
    crew: crewIds.map(x => base[x]?.name || '').filter(Boolean), scenes: out };
}

function aiCandidates(scenes = [], durationHours = 0) {
  const plan = aiState.planOptions || {};
  const excluded = new Set((Array.isArray(plan.excludeDates) ? plan.excludeDates : []).map(String));
  const priority = new Set((Array.isArray(plan.priorityMembers) ? plan.priorityMembers : []).map(String));
  const ids = new Set(scenes.flatMap(sceneRequiredCharacters).map(resolveMemberId).filter(id => base[id]));
  for (const name of scenes.flatMap(scene => sceneCrewNames(scene, aiProjectId()))) {
    const id = resolveMemberId(name);
    if (id) ids.add(id);
  }
  if (!ids.size) return { ids, items: [] };
  const all = entries(ids);
  const days = planDates();

  /* 씬마다 나오는 사람과 그 씬을 찍는 시간이 다르다.
     '묶음 전체 인원이 묶음 전체 시간 내내 비어야 한다'고 보면
     앞 두 씬만 찍고 빠지는 배우 때문에 그날 전체가 탈락한다.
     실제 촬영은 그렇게 짜지 않으므로 씬 단위로 따로 본다. */
  const spans = [];
  let cursor = 0;
  for (const scene of scenes) {
    const mins = sceneMinutes(scene);
    const who = new Set(sceneRequiredCharacters(scene).map(resolveMemberId).filter(id => base[id]));
    spans.push({ who, from: cursor / 60, to: (cursor + mins) / 60 });
    cursor += mins;
  }
  // 기획·촬영 담당은 어느 씬에도 안 적혀 있으니 전 구간을 지킨다.
  const totalHours = Math.max(Number(durationHours) || 0, cursor / 60, .5);
  const freeIn = (member, iso, a, b) => rangesOn(member, iso).some(r => +r.start <= a && +r.end >= b);

  const items = days.flatMap(({ iso, dayIndex }) => {
    const windows = all.flatMap(([id, member]) => {
      const mine = spans.filter(span => span.who.has(id));
      return (mine.length ? mine : [{ from: 0, to: totalHours }])
        .map(span => ({ ...span, ranges: rangesOn(member, iso) }));
    });
    return candidateStarts({ totalHours, windows }).map(time => {
    const yes = all.filter(([id, member]) => {
      const mine = spans.filter(s => s.who.has(id));
      // 출연하지 않는 사람(기획·촬영)은 처음부터 끝까지 있어야 한다
      if (!mine.length) return freeIn(member, iso, time, time + totalHours);
      return mine.every(s => freeIn(member, iso, time + s.from, time + s.to));
    });
    const yesIds = new Set(yes.map(([id]) => id));
    const continuity = continuityScore({
      date: iso, start: time, end: time + totalHours, requiredIds: [...ids],
      shoots: Object.values(shoots), memberIdsOfShoot: shootMemberIds,
    });
    return {
      iso, day: dayIndex, time, endTime: time + totalHours, all, yes,
      full: yes.length === ids.size, continuityHits: continuity.score, continuity: continuity.label,
      missing: [...state.required].filter(id => !yesIds.has(id)).map(id => members()[id]?.name).filter(Boolean),
    };
  }); })
    .filter(slot => new Date(`${slot.iso}T${String(slot.time).padStart(2, '0')}:00:00`).getTime() >= Date.now())
    // 기획자가 뺀 날짜는 후보에서 제외한다.
    .filter(slot => !excluded.has(slot.iso))
    .map(slot => ({
      ...slot,
      ratio: slot.yes.length / ids.size,
      // 우선 고려할 배우가 되는 시간대를 앞으로 올린다.
      priorityHits: priority.size ? slot.yes.filter(([id]) => priority.has(String(id))).length : 0,
    }))
    .filter(slot => slot.yes.length)
    /* 정렬 기준: 우선 인원 → 가능 인원(10% 단위) → 가까운 날짜 → 이른 시간.
       비율을 그대로 쓰면 5/6 과 6/6 처럼 한 명 차이로 2주 뒤가 1순위가 된다.
       10% 단위로 묶어 비슷하면 가까운 날을 고른다. */
    .sort((a, b) => Number(b.full) - Number(a.full)
      || b.continuityHits - a.continuityHits
      || b.priorityHits - a.priorityHits
      || Math.round(b.ratio * 10) - Math.round(a.ratio * 10)
      || (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0)
      || a.time - b.time
      || b.yes.length - a.yes.length)
    .slice(0, 10);
  return { ids, items };
}

const clockText = totalMinutes => hourText(Number(totalMinutes) / 60);

/** 공통 출연자와 같은 장소가 이어지도록 실제 이동이 적은 순서를 잡는다. */
function orderSceneGroup(rows) {
  if (rows.length < 2) return rows;
  const overlap = (a, b) => [...a.cast].filter(id => b.cast.has(id)).length;
  const build = first => {
    const left = rows.filter(row => row !== first), ordered = [first];
    while (left.length) {
      const prev = ordered.at(-1);
      left.sort((a, b) => overlap(prev, b) - overlap(prev, a) || b.cast.size - a.cast.size || a.index - b.index);
      ordered.push(left.shift());
    }
    return ordered;
  };
  const score = ordered => ordered.slice(1).reduce((sum, row, i) => sum
    + overlap(ordered[i], row) * 10
    + locationAffinity(ordered[i].scene, row.scene) * 8
    - Math.abs(ordered[i].cast.size - row.cast.size), 0);
  return rows.map(build).sort((a, b) => score(b) - score(a))[0];
}

function memberConstraint(id, iso, start, end) {
  const person = members()[id], name = person?.name || base[id]?.name || '미지정 인원';
  const spans = person ? rangesOn(person, iso) : [];
  const after = spans.find(span => +span.start > start && +span.start < end);
  if (after) return `${name} ${clockText(+spanMinutes(after.start))} 이후 가능`;
  const before = [...spans].reverse().find(span => +span.end > start && +span.end < end);
  if (before) return `${name} ${clockText(+spanMinutes(before.end))} 이전까지만 가능`;
  // 겹치는 구간이 아예 없으면 그 날 언제 되는지라도 알려준다.
  if (!spans.length) return `${name} 그날 종일 불가`;
  const free = spans.map(s => `${clockText(spanMinutes(s.start))}-${clockText(spanMinutes(s.end))}`).slice(0, 3).join(', ');
  return `${name} 이 시간 불가 (가능: ${free})`;
}
const spanMinutes = hour => Math.round(Number(hour) * 60);

/** 출연자 중첩 → 공통 가능 시간 → 호출 횟수 → 씬 순서 순으로 촬영안을 계산한다. */
function buildSceneSchedule(scenes = [], options = {}) {
  const castOf = scene => new Set(sceneRequiredCharacters(scene).map(resolveMemberId).filter(id => base[id]));
  const allRows = scenes.map((scene, index) => ({ index, scene, cast: castOf(scene), minutes: sceneMinutes(scene) }));

  /* 대본에 같은 씬 번호가 두 번 나오는 일이 있다(예: 'S#13 원형광장' 두 개).
     이름만으로 구분하면 두 씬이 한 씬으로 합쳐져 미배정이 유령으로 남고,
     하나를 확정하면 다른 하나까지 확정된 것으로 처리된다. 중복에만 (2) 를 붙인다. */
  const sceneIdByIndex = (() => {
    const seen = new Map(), out = new Map();
    for (const row of allRows) {
      const raw = row.scene.sceneId || `S#${row.index + 1}`;
      const n = (seen.get(raw) || 0) + 1;
      seen.set(raw, n);
      out.set(row.index, n > 1 ? `${raw} (${n})` : raw);
    }
    return out;
  })();
  const sceneIdAt = index => sceneIdByIndex.get(index) || `S#${index + 1}`;

  /* 이미 촬영 일정으로 확정한 씬은 다시 배치하지 않는다.
     '전체 다시 최적화' 를 고르면 확정분까지 포함해 처음부터 계산한다. */
  const pid = aiProjectId();
  const confirmedIds = new Set();
  if (!options.includeConfirmed) {
    for (const shoot of Object.values(shoots)) {
      if (!shoot || (pid && shoot.projectId !== pid)) continue;
      for (const id of (Array.isArray(shoot.sceneIds) ? shoot.sceneIds : [])) confirmedIds.add(String(id));
    }
  }
  const idOfRow = row => sceneIdAt(row.index);
  const confirmed = allRows.filter(row => confirmedIds.has(idOfRow(row)))
    .map(row => ({ sceneIndex: row.index, sceneId: idOfRow(row) }));

  /* 기획자가 '이번엔 빼자' 고 한 씬. 계산에서는 빠지지만 목록에서 사라지면 안 된다.
     아래에서 미배정으로 따로 보여 준다. */
  const skipped = new Set((Array.isArray(aiState.planOptions?.excludeScenes) ? aiState.planOptions.excludeScenes : []).map(String));
  const rows = allRows.filter(row => row.cast.size && !confirmedIds.has(idOfRow(row)) && !skipped.has(idOfRow(row)));
  const used = new Set(), groups = [];

  /* 기획자가 건 조건. 씬 번호(S#3)나 순번 둘 다 받는다. */
  const plan = aiState.planOptions || {};
  const idOf = row => sceneIdAt(row.index);
  const keyset = list => new Set((Array.isArray(list) ? list : []).map(String));
  // 강제 묶기: 같은 묶음에 적힌 씬들은 반드시 한 그룹으로 간다.
  const pinnedSets = (Array.isArray(plan.pinned) ? plan.pinned : []).map(keyset);
  const pinnedOf = row => pinnedSets.find(set => set.has(idOf(row)) || set.has(String(row.index)));
  // 강제 분리: 여기 함께 적힌 씬들은 절대 같은 그룹에 두지 않는다.
  const splitSets = (Array.isArray(plan.split) ? plan.split : []).map(keyset);
  const mustSplit = (row, others) => splitSets.some(set => {
    const hit = key => set.has(key);
    return (hit(idOf(row)) || hit(String(row.index)))
      && others.some(other => hit(idOf(other)) || hit(String(other.index)));
  });

  /* 한 번에 몰아 찍을 분량의 상한. 없으면 배역이 이어지는 씬이 전부 한 덩어리가 되어
     "하루에 다 찍자"는 쓸모없는 답이 나온다. 설정에서 늘리면 더 몰아서 잡는다.
     실제 크기는 아래에서 그날 되는 시간을 보며 다시 줄인다. */
  /* 촬영 여유도: 빡빡할수록 하루에 더 몰아넣는다. 숫자를 직접 입력하지 않아도 된다. */
  const pace = { '빡빡하게': 1.35, '보통': 1, '여유롭게': 0.7 }[appSettings.shootPace || '보통'] ?? 1;
  const capacity = Math.max(60, Math.round((Number(appSettings.shootDayHours) || 4) * 60 * pace));
  // 보조 제한. 시간이 남아도 씬 수가 너무 많으면 나눈다.
  const maxScenes = Math.max(0, Number(appSettings.shootMaxScenes) || 0);

  // 덜어낸 씬이 다시 잡히도록 '아직 안 쓴 씬'을 매번 새로 찾는다.
  let guard = rows.length * 4;
  while (guard-- > 0) {
    /* 출연이 많은 씬부터 묶음의 씨앗으로 삼는다. 대본 순서대로 잡으면
       1인 씬이 먼저 씨앗이 되어 혼자 하루를 차지해 버린다. */
    const seed = rows.filter(row => !used.has(row.index))
      .sort((x, y) => y.cast.size - x.cast.size || x.index - y.index)[0];
    if (!seed) break;
    const selected = [];
    /* 씬 하나를 가져갈 때 같이 묶으라고 지정된 씬은 항상 함께 끌고 온다.
       나중에 씨앗이 되기를 기다리면 그 전에 다른 그룹에 흡수돼 버린다. */
    const take = row => {
      if (used.has(row.index)) return;
      selected.push(row); used.add(row.index);
      const pin = pinnedOf(row);
      if (!pin) return;
      for (const mate of rows) {
        if (used.has(mate.index) || !(pin.has(idOf(mate)) || pin.has(String(mate.index)))) continue;
        take(mate);
      }
    };
    take(seed);
    while (true) {
      const minutes = selected.reduce((sum, row) => sum + row.minutes, 0);
      const groupCast = new Set(selected.flatMap(row => [...row.cast]));
      if (maxScenes && selected.length >= maxScenes) break;
      const next = rows.filter(row => !used.has(row.index) && minutes + row.minutes <= capacity)
        .filter(row => !mustSplit(row, selected))
        .map(row => {
          const overlap = [...row.cast].filter(id => groupCast.has(id)).length;
          const added = [...row.cast].filter(id => !groupCast.has(id)).length;
          /* 겹치는 사람은 이득, 새로 부르는 사람은 손해. 호출 인원이 늘기만 하는 씬은 넣지 않는다.
             1인 씬은 먼저 챙긴다. 뒤로 밀면 하루 분량이 차서 혼자 하루를 쓰게 된다. */
          const samePlace = selected.reduce((n, picked) => n + locationAffinity(row.scene, picked.scene), 0);
          return { row, overlap, score: overlap * 2 + samePlace * 3 - added + (row.cast.size === 1 ? 3 : 0) };
        })
        // 1인 씬은 그 사람이 이미 오는 날이면 무조건 끼워 넣는다. 혼자 하루를 잡을 이유가 없다.
        .filter(item => item.overlap > 0 && (item.score > 0 || item.row.cast.size === 1))
        .sort((a, b) => b.score - a.score || b.overlap - a.overlap || a.row.index - b.row.index)[0]?.row;
      if (!next) break;
      take(next);
    }

    /* 하루에 몇 시간 찍을지는 그날 다 같이 되는 시간이 정한다.
       들어갈 시간이 없으면 뒤 씬부터 덜어내고, 덜어낸 씬은 다음 그룹으로 돌린다.
       강제로 묶으라고 한 씬은 덜어내지 않는다. */
    let ordered = orderSceneGroup(selected);
    const calculate = list => aiCandidates(list.map(row => row.scene), list.reduce((s, r) => s + r.minutes, 0) / 60);
    const hasFull = value => value.items.some(slot => slot.full);
    let result = calculate(ordered);
    while (!hasFull(result) && ordered.length > 1) {
      /* 통째로 찍을 시간이 없으면 아무 씬이나 뒤에서 자르지 않는다.
         한 씬씩 빼 본 뒤 전원 가능 후보와 장소 묶음이 가장 잘 남는 조합을 고른다. */
      const choices = ordered.map((row, index) => ({ row, index }))
        .filter(({ row }) => !pinnedOf(row))
        .map(choice => {
          const kept = ordered.filter((_, index) => index !== choice.index);
          const candidate = calculate(kept);
          const fullCount = candidate.items.filter(slot => slot.full).length;
          const placeScore = kept.reduce((sum, row, index) => sum
            + kept.slice(index + 1).reduce((n, other) => n + locationAffinity(row.scene, other.scene), 0), 0);
          return { ...choice, kept, candidate, fullCount, placeScore };
        })
        .sort((a, b) => b.fullCount - a.fullCount
          || (b.candidate.items[0]?.continuityHits || 0) - (a.candidate.items[0]?.continuityHits || 0)
          || b.placeScore - a.placeScore
          || b.row.index - a.row.index);
      const choice = choices[0];
      if (!choice) break;
      ordered = choice.kept;
      used.delete(choice.row.index);
      result = choice.candidate;
    }
    const groupScenes = ordered.map(row => row.scene);
    const everyone = new Set(ordered.flatMap(row => [...row.cast]));
    const shared = [...everyone].filter(id => ordered.every(row => row.cast.has(id)));
    const partial = [...everyone].filter(id => !shared.includes(id));
    const minutes = ordered.reduce((sum, row) => sum + row.minutes, 0);
    const requiredIds = [...result.ids];
    // 같은 날 겹치는 시간대만 3개 주면 선택지가 아니다. 날짜를 나눠 고른 뒤 모자라면 채운다.
    const byDay = new Map();
    for (const slot of result.items) if (!byDay.has(slot.day)) byDay.set(slot.day, slot);
    const picked = [...byDay.values()].slice(0, 3);
    for (const slot of result.items) { if (picked.length >= 3) break; if (!picked.includes(slot)) picked.push(slot); }
    const candidates = picked.map((slot, rank) => {
      const availableIds = new Set(slot.yes.map(([id]) => id));
      const missingIds = requiredIds.filter(id => !availableIds.has(id));
      const startMinute = slot.time * 60;
      const callTimes = requiredIds.map(id => {
        const positions = ordered.map((row, index) => row.cast.has(id) ? index : -1).filter(index => index >= 0);
        const crew = !positions.length;
        const first = crew ? 0 : Math.min(...positions), last = crew ? ordered.length - 1 : Math.max(...positions);
        const begins = startMinute + ordered.slice(0, first).reduce((sum, row) => sum + row.minutes, 0);
        const ends = startMinute + ordered.slice(0, last + 1).reduce((sum, row) => sum + row.minutes, 0);
        return { id, name: base[id]?.name || '', start: clockText(begins), end: clockText(ends), role: crew ? '스태프' : '출연' };
      }).filter(person => person.name);
      return {
        rank: rank + 1, day: slot.day, date: slot.iso, time: slot.time, endTime: slot.endTime,
        available: slot.yes.map(([id, person]) => ({ id, name: person.name })), total: result.ids.size,
        full: !missingIds.length,
        continuity: slot.continuity,
        // '기획 확인 필요' 만 적으면 몇 명이 막히는지 알 수 없다. 숫자와 이름을 같이 적는다.
        status: missingIds.length
          ? `${requiredIds.length - missingIds.length}/${requiredIds.length}명 가능`
          : '전원 가능',
        blockedNames: missingIds.map(id => base[id]?.name || '').filter(Boolean),
        constraints: missingIds.map(id => memberConstraint(id, slot.iso, slot.time, slot.endTime)), callTimes,
        /* '이 날 15개 찍을 수 있음' 만으로는 무엇을 확정할지 판단할 수 없다.
           추천 / 추가 가능 / 충돌 로 나눠 준다. */
        breakdown: (() => {
          const core = [], optional = [], blocked = [];
          for (const row of ordered) {
            const sceneId = sceneIdAt(row.index);
            const out = [...row.cast].filter(id => !availableIds.has(id));
            if (out.length) {
              blocked.push({ sceneId, index: row.index,
                why: `${out.map(id => base[id]?.name || '').filter(Boolean).join(', ')} 일정 불가` });
              continue;
            }
            // 다른 씬과 얼마나 엮여 있는지로 '적극 추천'과 '가능'을 가른다.
            const linked = ordered.filter(other => other !== row)
              .reduce((n, other) => n + ([...row.cast].some(id => other.cast.has(id)) ? 1 : 0), 0);
            const withShared = shared.some(id => row.cast.has(id));
            if (withShared || linked >= 2) core.push({ sceneId, index: row.index });
            else optional.push({ sceneId, index: row.index,
              why: '다른 날에 묶는 편이 나을 수 있습니다' });
          }
          return { core, optional, blocked };
        })(),
      };
    });
    /* 왜 이 씬들을 묶었는지 사람이 읽을 문장으로 만든다.
       '씬1과 씬3에 강주형·신유진이 공통 출연' 처럼 실제 겹침을 근거로 적는다. */
    const nameOf = id => base[id]?.name || '';
    const links = [];
    for (let i = 0; i + 1 < ordered.length && links.length < 3; i += 1) {
      const both = [...ordered[i].cast].filter(id => ordered[i + 1].cast.has(id)).map(nameOf).filter(Boolean);
      if (!both.length) continue;
      const a = sceneIdAt(ordered[i].index);
      const b = sceneIdAt(ordered[i + 1].index);
      links.push(`${a}과 ${b}에 ${both.join('·')}이(가) 함께 나옵니다`);
    }
    const sharedText = shared.length
      ? `${shared.map(nameOf).filter(Boolean).join('·')}은(는) 이 묶음 전체에 나옵니다.`
      : '';
    const reason = [
      links.join(', ') + (links.length ? '.' : ''),
      sharedText,
      ordered.length > 1 ? `따로 찍으면 ${ordered.length}번 불러야 할 인원을 한 번에 모을 수 있습니다.` : '',
    ].filter(Boolean).join(' ');

    const placeLinks = [];
    for (let i = 0; i + 1 < ordered.length; i += 1) {
      if (!locationAffinity(ordered[i].scene, ordered[i + 1].scene)) continue;
      placeLinks.push(`${sceneIdAt(ordered[i].index)}과 ${sceneIdAt(ordered[i + 1].index)}은(는) 같은 장소 동선입니다`);
    }
    groups.push({
      key: ordered.map(row => row.index).join('-'), sceneIndexes: ordered.map(row => row.index),
      reason,
      sceneIds: ordered.map(row => sceneIdAt(row.index)),
      totalPeople: everyone.size, sharedNames: shared.map(id => base[id]?.name || '').filter(Boolean),
      sharedIds: shared, linkLines: [...placeLinks.slice(0, 2), ...links].slice(0, 3),
      partialNames: partial.map(id => base[id]?.name || '').filter(Boolean), estimatedMinutes: minutes,
      candidates,
      // 후보 자체가 없을 때만 '못 잡은' 것이다. 일부 인원만 빠지는 건 묶음 카드에서 보여 준다.
      needsReview: !candidates.length,
      partialOnly: candidates.length > 0 && !candidates.some(candidate => candidate.full),
      reviewReason: candidates.length ? '' : '이 묶음을 통째로 찍을 시간이 없습니다. 기간을 넓히거나 씬을 나눠 주세요.',
    });
  }

  const unassigned = allRows.filter(row => !row.cast.size && !confirmedIds.has(idOfRow(row)) && !skipped.has(idOfRow(row))).map(row => ({
    sceneIndex: row.index, sceneId: sceneIdAt(row.index),
    reason: sceneRequiredCharacters(row.scene).length ? '배역과 등록 인원을 연결해야 합니다.' : '출연자가 분석되지 않았습니다.',
  }));
  // 사용자가 뺀 씬. 이유를 적어 두어야 나중에 왜 빠졌는지 알 수 있다.
  for (const row of allRows) {
    if (!skipped.has(idOfRow(row)) || confirmedIds.has(idOfRow(row))) continue;
    unassigned.push({ sceneIndex: row.index, sceneId: sceneIdAt(row.index), excluded: true,
      reason: '이번 추천에서 제외한 씬입니다.' });
  }
  /* 검토가 필요한 묶음은 씬 단위로 풀어서 보여준다.
     15씬을 한 줄로 이어 붙이면 읽을 수가 없다. 막고 있는 사람 이름도 함께 적는다. */
  for (const group of groups.filter(group => group.needsReview)) {
    group.sceneIds.forEach((sceneId, at) => unassigned.push({
      sceneIndex: group.sceneIndexes[at], sceneId, groupKey: group.key, reason: group.reviewReason,
    }));
  }
  const planned = new Set(groups.flatMap(g => g.sceneIds));
  return {
    groups: groups.sort((a, b) => {
      const x = a.candidates.find(candidate => candidate.full) || a.candidates[0];
      const y = b.candidates.find(candidate => candidate.full) || b.candidates[0];
      return String(x?.date || '9999').localeCompare(String(y?.date || '9999'))
        || Number(x?.time || 99) - Number(y?.time || 99)
        || b.sceneIndexes.length - a.sceneIndexes.length;
    }),
    unassigned, confirmed,
    // 미배정이 0 이 될 때까지 추적할 수 있어야 한다.
    totals: {
      all: allRows.length,
      confirmed: confirmed.length,
      planning: planned.size,
      unassigned: allRows.length - confirmed.length - planned.size,
      conflicts: groups.reduce((n, g) => n + ((g.candidates[0]?.blockedNames || []).length ? 1 : 0), 0),
      days: groups.length,
    },
  };
}

const buildSceneGroups = scenes => buildSceneSchedule(scenes).groups;

function renderAI() {
  const pid = aiProjectId();
  const saved = projects[pid]?.aiAnalysis || {};
  const job = aiCurrentJob();
  const scenes = job?.scenes || saved.scenes || [];
  state.aiSceneIndex = Math.max(0, Math.min(state.aiSceneIndex, Math.max(0, scenes.length - 1)));
  const scene = scenes[state.aiSceneIndex] || null;
  const chars = [...new Set([...aiCharacters(scenes), ...(Array.isArray(job?.castMappings) ? job.castMappings.map(item => item.character).filter(Boolean) : [])])];
  const mappings = { ...(saved.characterMappings || {}), ...aiState.mappings };
  const health = aiState.health;
  const connected = !!health?.configured;
  const items = job?.items || [];
  const success = items.filter(x => x.status === 'success').length;
  const failed = items.filter(x => x.status === 'failed').length;
  const pending = Math.max(0, items.length - success - failed);
  const progress = job?.status === 'completed' ? 100 : (job?.progress || 0);
  const requiredCharacters = sceneRequiredCharacters(scene);
  const candidates = aiCandidates(scene ? [scene] : []);
  const projectOpts = Object.entries(projects).sort(([,a],[,b]) => (a.createdAt||0)-(b.createdAt||0)).map(([id,p]) => `<option value="${esc(id)}" ${id === pid ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const memberOpts = selected => `<option value="">미지정</option>${sortedPeople().map(([id,m]) => `<option value="${esc(id)}" ${id === selected ? 'selected' : ''}>${esc(m.name)} · ${esc(m.department || '미지정')}</option>`).join('')}`;
  const sceneList = scenes.length ? scenes.map((s, i) => `<button data-act="ai-scene" data-i="${i}" class="${i === state.aiSceneIndex ? 'is-active' : ''}"><span>${esc(s.sceneId || `S#${i+1}`)}</span><b>${esc(s.location || s.title || '장소 미정')}</b><em class="is-success">완료</em></button>`).join('') : '<div class="ai-empty-list">분석된 장면이 없습니다.</div>';
  const failedRows = items.filter(x => x.status === 'failed').map(x => `<div class="ai-failed-row"><span>묶음 ${x.index + 1} · ${esc(x.error || '분석 실패')}</span><button data-act="ai-retry" data-i="${x.index}"><i class="fa-solid fa-rotate-right"></i> 재시도</button></div>`).join('');
  const listValue = value => esc((Array.isArray(value) ? value : []).join(', '));
  const detail = scene ? `<form class="ai-scene-form" data-form="ai-scene">
      <input type="hidden" name="index" value="${state.aiSceneIndex}">
      <div class="ai-form-head"><div><b>장면 상세 정보</b><small>AI 결과를 직접 수정할 수 있습니다.</small></div><button type="submit">저장</button></div>
      <div class="ai-form-grid"><label>장면 번호<input name="sceneId" value="${esc(scene.sceneId || '')}"></label><label class="wide">촬영 위치<input name="location" value="${esc(scene.location || '')}"></label>
      <label>실내/실외<select name="interiorExterior">${['UNKNOWN','INT','EXT'].map(x => `<option ${scene.interiorExterior === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label>낮/밤<select name="dayNight">${['UNKNOWN','DAY','NIGHT'].map(x => `<option ${scene.dayNight === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label>예상 시간(분)<input name="estimatedMinutes" type="number" min="0" value="${+scene.estimatedMinutes || 0}"></label>
      <label class="wide">등장 배역<input name="characters" value="${listValue(scene.characters)}"></label><label class="full">장면 요약<textarea name="summary">${esc(scene.summary || '')}</textarea></label></div>
    </form>` : '<div class="ai-detail-empty"><i class="fa-regular fa-file-lines"></i><b>대본을 업로드해 분석을 시작하세요.</b><span>완료된 장면은 이곳에서 수정할 수 있습니다.</span></div>';
  const activeItem = items.find(x => x.status === 'running');
  const progressTitle = ['queued', 'running'].includes(job?.status) ? '대본 분석 중' : job?.status === 'completed' ? '분석 완료' : job?.status === 'partial' ? '일부 분석 완료' : '분석 대기';
  const candidateRows = candidates.items.map(s => `<button data-act="ai-candidate" data-day="${s.day}" data-time="${s.time}" class="${s.yes.length === candidates.ids.size ? 'is-full' : 'is-partial'}"><b>${DAYS[s.day]} ${String(s.time).padStart(2,'0')}:00–${String(s.time+1).padStart(2,'0')}:00</b><span>${s.yes.length}/${candidates.ids.size}명 ${s.yes.length === candidates.ids.size ? '전체 가능' : '부분 가능'}</span></button>`).join('') || `<div class="ai-side-empty">${scene ? `${esc(scene.sceneId || '선택한 씬')}의 필요 배역을 실제 인원과 연결하면 계산됩니다.` : '먼저 씬을 선택하세요.'}</div>`;
  const stage = job?.status === 'completed' ? 3 : ['queued','running','partial'].includes(job?.status) ? 2 : aiState.extractedText ? 1 : 0;
  const recent = Object.values(saved.analysisJobs || {}).filter(Boolean).sort((a,b)=>String(b.updatedAt||b.createdAt||'').localeCompare(String(a.updatedAt||a.createdAt||''))).slice(0,4);
  const serverLogs = (job?.logs || []).slice(-100).reverse();
  const serverLogRows = serverLogs.map(entry => `<li><time>${esc(entry.time || '--:--:--')}</time><em class="${esc(entry.level || 'info')}">${esc(entry.level || 'info')}</em><span>${esc(entry.message || '')}</span></li>`).join('');

  return `<main class="view ai-view">
    <header class="view-head"><div class="view-title-row"><div><h1>AI 분석</h1><p class="sub">대본에서 씬·장소·등장 배역을 찾고 실제 시간표로 촬영 후보를 계산합니다.</p></div></div></header>
    <section class="ai-stepper">${[['fa-file-arrow-up','대본 선택'],['fa-sliders','분석 설정'],['fa-wand-magic-sparkles','AI 분석'],['fa-calendar-check','일정 후보']].map(([icon,label],i)=>`<span class="${i<=stage?'is-active':''}"><i class="fa-solid ${icon}"></i><b>${label}</b></span>${i<3?'<em></em>':''}`).join('')}</section>
    <section class="ai-top-grid">
      <article class="ai-card ai-upload-card"><div class="ai-card-title"><h3>대본 업로드</h3><span>PDF · DOCX · TXT, 최대 20MB</span></div><div class="ai-project-row"><label>프로젝트<select data-act="ai-project">${projectOpts || '<option value="">프로젝트 없음</option>'}</select></label><button data-act="project-open"><i class="fa-solid fa-plus"></i> 프로젝트</button><button class="ai-reset" data-act="ai-reset" ${!job ? 'disabled' : ''}><i class="fa-solid fa-rotate-left"></i> 분석 초기화</button></div><input id="aiFileInput" type="file" accept=".pdf,.docx,.txt" hidden><button class="ai-drop" data-act="ai-file"><i class="fa-solid fa-cloud-arrow-up"></i><span>${aiState.extracting ? '텍스트 추출 중…' : aiState.file ? esc(aiState.file.name) : '파일을 선택하거나 이곳에 놓으세요'}</span><small>${aiState.extractedText ? `${aiState.extractedText.length.toLocaleString()}자 추출 완료` : '원본 파일은 Firebase에 저장하지 않습니다.'}</small></button><div class="ai-option-row">${[['scenes','씬·장소'],['cast','등장 배역'],['locations','소품·장비'],['schedule','시간표 후보']].map(([key,label])=>`<label><input type="checkbox" data-ai-option="${key}" ${aiState.options[key]?'checked':''}><span>${label}</span></label>`).join('')}</div><button class="ai-start" data-act="ai-start" ${!pid || !aiState.extractedText || !connected || job?.status === 'running' ? 'disabled' : ''}><i class="fa-solid fa-play"></i> 분석 시작</button></article>
      <article class="ai-card ai-progress-card ${['queued','running'].includes(job?.status) ? 'is-running' : ''}"><div class="ai-progress-main"><div class="ai-ring" style="--progress:${progress}"><strong>${progress}%</strong></div><div class="ai-progress-copy"><span>${progressTitle}</span><b>${activeItem ? `장면 묶음 ${activeItem.index + 1} / ${items.length} 처리 중` : job?.status === 'completed' ? `${scenes.length}개 장면 분석 완료` : '대본을 선택하면 분석을 시작할 수 있습니다.'}</b><div class="ai-progress-bar"><i style="width:${progress}%"></i></div><div class="ai-counts"><span><small>완료</small><b>${success}</b></span><span class="bad"><small>실패</small><b>${failed}</b></span><span><small>대기</small><b>${pending}</b></span></div></div></div>${failedRows}</article>
    </section>
    <section class="ai-card ai-log-card"><div class="ai-card-title"><h3>서버 로그</h3><span>${serverLogs.length ? '실시간 업데이트' : '대기 중'}</span></div><ul aria-live="polite">${serverLogRows || '<li class="is-empty">분석을 시작하면 백그라운드 서버 로그가 표시됩니다.</li>'}</ul></section>
    <section class="ai-work-grid">
      <article class="ai-card ai-scene-list"><div class="ai-card-title"><h3>장면 목록</h3><span>${scenes.length}개</span></div><div>${sceneList}</div></article>
      <article class="ai-card ai-scene-detail">${detail}</article>
      <aside class="ai-side-stack"><article class="ai-card ai-candidate-card"><div class="ai-card-title"><h3>${esc(scene?.sceneId || '씬')} 촬영 일정 후보</h3><span>필요 배역 ${requiredCharacters.length}명 기준</span></div><div class="ai-required-roles">${requiredCharacters.map(name => `<span>${esc(name)}</span>`).join('') || '<small>필요 배역 없음</small>'}</div><div class="ai-candidate-list">${candidateRows}</div></article><article class="ai-card ai-mapping-card"><div class="ai-card-title"><h3>배역 → 인원 매칭</h3><span>자동 ${Object.values(mappings).filter(Boolean).length}/${chars.length}</span></div><div class="ai-mapping-list">${chars.map(name => `<label><span>${esc(name)}</span><select data-act="ai-mapping" data-character="${esc(name)}">${memberOpts(mappings[name])}</select></label>`).join('') || '<div class="ai-side-empty">대본의 배역표와 담당 인원을 자동으로 연결합니다.</div>'}</div></article></aside>
    </section>
    <section class="ai-recent"><div class="ai-card-title"><h3>최근 분석</h3><span>${recent.length}건</span></div><div>${recent.map(x=>`<article><i class="fa-solid fa-file-lines"></i><span><b>${esc(x.filename||saved.script?.filename||projects[pid]?.name||'대본 분석')}</b><small>${esc(x.status||'완료')} · ${(x.scenes||[]).length}개 장면</small></span><em>${x.progress||0}%</em></article>`).join('')||'<p>이 프로젝트의 분석 기록이 없습니다.</p>'}</div></section>
  </main>`;
}

/* ----- member management ----- */
function renderMembers() {
  const query = state.memberQuery.trim().toLocaleLowerCase('ko');
  const filters = ['all', ...DEPARTMENT_ORDER];
  const people = sortedPeople().filter(([, m]) => (state.memberFilter === 'all' || m.department === state.memberFilter) && (!query || `${m.name} ${m.department || ''} ${m.position || ''} ${m.email || ''}`.toLocaleLowerCase('ko').includes(query)));
  const rows = people.map(([id, m]) => `<tr><td><span class="members-avatar">${esc(m.name.slice(0,1))}</span><b>${esc(m.name)}</b></td><td>${esc(m.department || '미지정')}</td><td>${esc(m.position || m.role || '—')}</td><td>${esc(m.email || m.contact || '—')}</td><td>${fixedItems(id,m).length}개</td><td><div class="members-row-actions"><button data-act="fixed-open" data-id="${esc(id)}" title="고정 시간표"><i class="fa-regular fa-calendar-plus"></i></button><button class="danger" data-act="member-delete" data-id="${esc(id)}" title="삭제"><i class="fa-regular fa-trash-can"></i></button></div></td></tr>`).join('');
  return `<main class="view members-view"><header class="view-head"><div class="view-title-row"><div><h1>인원 관리</h1><p class="sub">방송국 인원과 부서, 고정 시간표를 관리하세요.</p></div><div class="members-primary-actions"><button data-act="member-csv"><i class="fa-solid fa-file-arrow-up"></i> CSV 가져오기</button><button class="btn-primary" data-act="member-add"><i class="fa-solid fa-user-plus"></i> 인원 추가</button></div></div></header>
  <section class="members-board"><div class="members-board-tools"><div class="members-filter-tabs">${filters.map(f=>`<button data-act="member-filter" data-filter="${esc(f)}" class="${state.memberFilter===f?'is-active':''}">${f==='all'?'전체':esc(f)} <small>${f==='all'?Object.keys(base).length:Object.values(base).filter(m=>m.department===f).length}</small></button>`).join('')}</div><label><i class="fa-solid fa-magnifying-glass"></i><input id="memberSearch" value="${esc(state.memberQuery)}" placeholder="이름, 부서 검색"></label><input id="memberCsvInput" type="file" accept=".csv,text/csv" hidden></div>
  <div class="members-table-wrap"><table class="members-table"><thead><tr><th>이름</th><th>부서</th><th>직책</th><th>연락처</th><th>고정 일정</th><th></th></tr></thead><tbody>${rows||`<tr><td colspan="6" class="members-empty">조건에 맞는 인원이 없습니다.</td></tr>`}</tbody></table></div></section></main>`;
}

/* ----- settings view ----- */
function renderSettings() {
  const people = sortedPeople();
  const groups = Object.entries(people.reduce((o, p) => { const d = p[1].department || '미지정'; (o[d] ??= []).push(p); return o; }, {}));
  return `<main class="view">
    <header class="view-head">
      <div class="view-title-row"><div><h1>설정</h1><p class="sub">더 편리한 촬영 관리를 위한 환경을 설정하세요.</p></div></div>
    </header>
    <div class="reference-settings-layout"><aside class="settings-inner-nav"><button class="is-active"><i class="fa-solid fa-gear"></i> 일반 설정</button><button data-act="radio-open"><i class="fa-solid fa-microphone-lines"></i> 라디오 방송</button><button data-act="member-add"><i class="fa-solid fa-user-plus"></i> 인원 추가</button><button data-act="admin-open"><i class="fa-solid fa-shield-halved"></i> 관리자</button><span></span><button><i class="fa-solid fa-database"></i> 데이터 관리</button><button><i class="fa-solid fa-circle-info"></i> 서비스 정보</button></aside><div class="settings-reference-content"><section class="settings-reference-card"><header><i class="fa-solid fa-user-group"></i><div><h2>인원·수업 시간표 관리</h2><p>전체 ${people.length}명 · 수업과 방송 시간은 가능 시간에서 자동 제외 · 라디오 ${radioItems().length}개</p></div><div class="members-head-actions"><button data-act="radio-open"><i class="fa-solid fa-microphone-lines"></i> 라디오 방송 입력</button><button data-act="member-add"><i class="fa-solid fa-user-plus"></i> 인원 추가하기</button></div></header>
      <div class="settings-departments">${groups.map(([dept, its]) => `
        <section class="settings-department ${state.settingsOpenDepts.has(dept) ? 'is-open' : ''}">
        <button class="settings-department-toggle" data-act="settings-department-toggle" data-dept="${esc(dept)}" aria-expanded="${state.settingsOpenDepts.has(dept)}"><b>${esc(dept)}</b><span><small>${its.length}명</small><i class="fa-solid fa-chevron-down"></i></span></button>
        <div class="members-live-grid settings-people">${its.map(([id, m]) => {
          const count = fixedItems(id, m).length;
          return `<article><div class="member-avatar">${esc(m.name.slice(0, 1))}</div>
            <div class="member-info"><b>${esc(m.name)}</b><span>${esc(m.department || '미지정')} · 수업 ${count}개</span></div>
            <div class="member-actions"><button data-act="fixed-open" data-id="${esc(id)}" aria-label="${esc(m.name)} 수업"><i class="fa-regular fa-calendar-plus"></i></button>
            <button class="member-delete" data-act="member-delete" data-id="${esc(id)}" aria-label="${esc(m.name)} 삭제"><i class="fa-regular fa-trash-can"></i></button></div>
          </article>`;
        }).join('')}</div></section>`).join('')}</div></section><section class="settings-reference-card settings-data-card"><header><i class="fa-solid fa-database"></i><div><h2>데이터 관리</h2><p>Firebase에 저장된 인원과 일정 데이터를 관리합니다.</p></div></header><div><button data-act="admin-open"><span><b>관리자 도구</b><small>AI 서버 상태와 시스템 로그 확인</small></span><i class="fa-solid fa-chevron-right"></i></button><button data-act="data-reload"><span><b>데이터 다시 불러오기</b><small>최신 Firebase 데이터를 새로고침</small></span><i class="fa-solid fa-rotate"></i></button></div></section></div></div>
  </main>`;
}

const VIEWS = { home: renderMobileHome, week: renderWeek, analysis: renderAnalysis, shoot: renderShootReference, personal: renderPersonalReference, members: renderMembers, ai: renderAI, settings: renderSettings };
const MOBILE_VIEWS = { home: renderMobileHome, week: renderMobileWeek, analysis: renderMobileAnalysis, shoot: renderMobileShoot, personal: renderMobilePersonal, ai: renderMobileAI, settings: renderMobileSettings };

function render() {
  const mobile = window.matchMedia('(max-width: 760px)').matches;
  const renderer = mobile ? (MOBILE_VIEWS[state.view] || renderMobileHome) : (VIEWS[state.view] || renderWeek);
  $app().innerHTML = renderSidebar() + renderer() + renderMobileBottomNav() + renderDataWarning();
  const stage = document.getElementById('tmStage');
  if (stage) stage.addEventListener('wheel', e => {
    e.preventDefault();
    const dir = e.deltaY > 0 ? 1 : -1;
    const n = Object.keys(projects).length;
    setState(s => ({ shootSlide: Math.max(0, Math.min(n - 1, s.shootSlide + dir)), shootOpen: false }));
  }, { passive: false });
}

/* ================================================================== MODALS */
function modal(id, cls, title, bodyHtml) {
  let m = document.getElementById(id);
  if (!m) { m = document.createElement('div'); m.id = id; m.className = 'app-modal'; document.body.append(m); }
  m.classList.toggle('radio-modal-wide-host', cls === 'wide');
  m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', `${id}Title`);
  m.innerHTML = `<div class="app-modal-card${cls === 'wide' ? ' radio-modal-wide' : cls === 'register' ? ' register-modal-wide' : cls === 'shoot' ? ' shoot-modal-wide' : ''}">
    <div class="app-modal-head"><b id="${id}Title">${esc(title)}</b><button data-act="modal-close" data-modal="${id}" aria-label="닫기">×</button></div>
    <div class="app-modal-body">${bodyHtml}</div></div>`;
  m.classList.add('open');
  requestAnimationFrame(() => m.querySelector('input, select, button')?.focus());
  return m;
}
const closeModal = id => document.getElementById(id)?.classList.remove('open');
const closeAllModals = () => document.querySelectorAll('.app-modal.open').forEach(m => m.classList.remove('open'));

function projectOptions(sel) {
  return `<option value="">미분류</option>` + Object.entries(projects).sort(([, a], [, b]) => (a.createdAt || 0) - (b.createdAt || 0))
    .map(([id, p]) => `<option value="${esc(id)}" ${id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
}

function openRegisterModal(memberId = '', preset = {}) {
  const selectedDay = Number.isFinite(preset.day) ? preset.day : 0;
  const selectedStart = Number.isFinite(preset.start) ? preset.start : 9;
  const selectedEnd = Number.isFinite(preset.end) ? preset.end : Math.min(23, selectedStart + 1);
  const options = Object.entries(base).sort(([, a], [, b]) => a.name.localeCompare(b.name, 'ko'))
    .map(([id, m]) => `<option value="${esc(id)}" ${id === memberId ? 'selected' : ''}>${esc(m.name)} · ${esc(m.department || '미지정')}</option>`).join('');
  const currentSchedule = memberId ? memberWeek(memberId, base[memberId])?.schedules?.[dates()[selectedDay]] : null;
  modal('appModal', 'register', '개인 일정 등록', `
    <form id="registrationForm" class="register-form" data-form="register">
      <label class="register-member">인원<select name="member" required>${options}</select></label>
      <fieldset class="register-days"><legend>날짜</legend><input type="hidden" name="day" value="${selectedDay}">
        <div>${dates().map((d, i) => `<button type="button" data-act="register-choice" data-name="day" data-value="${i}" aria-pressed="${i === selectedDay}"><b>${DAYS[i]}</b><small>${esc(d.match(/\d+월 \d+일/)?.[0] || d)}</small></button>`).join('')}</div>
      </fieldset>
      <fieldset class="register-status"><legend>상태</legend><input type="hidden" name="status" value="가능">
        <div><button type="button" data-act="register-choice" data-name="status" data-value="가능" aria-pressed="true"><i class="fa-solid fa-check"></i> 가능</button><button type="button" data-act="register-choice" data-name="status" data-value="불가능" aria-pressed="false"><i class="fa-solid fa-xmark"></i> 불가능</button></div>
      </fieldset>
      <div class="form-times register-times"><label>시작<select name="start">${TIMES.map(t => `<option value="${t}" ${t === selectedStart ? 'selected' : ''}>${String(t).padStart(2, '0')}:00</option>`).join('')}</select></label>
      <label>종료<select name="end">${END_TIMES.map(t => `<option value="${t}" ${t === selectedEnd ? 'selected' : ''}>${String(t).padStart(2, '0')}:00</option>`).join('')}</select></label></div>
      <div class="register-duration"><span>빠른 시간 설정</span><div>${[1, 2, 3, 4].map(h => `<button type="button" data-act="register-duration" data-hours="${h}">${h}시간</button>`).join('')}<button type="button" data-act="register-duration" data-hours="all">하루 전체</button></div></div>
      <label class="register-memo">메모<input name="memo" placeholder="약속, 알바, 방송 등 (선택)"></label>
      <div class="register-footer"><p class="form-note">입력하지 않은 시간은 표에서 공백이지만 가능 인원 계산에는 포함됩니다. 수업은 고정 시간표에서 관리합니다.</p><div class="modal-btn-row">${currentSchedule ? `<button class="app-danger" type="button" data-act="personal-day-delete" data-id="${esc(memberId)}" data-day="${selectedDay}">이 날짜 개인 일정 삭제</button>` : ''}<button class="app-primary" type="submit">개인 일정 저장</button></div></div>
    </form>`);
}

function openMemberModal() {
  modal('appModal', '', '인원 추가하기', `
    <form id="memberForm" data-form="member">
      <label>이름<input name="name" required placeholder="이름"></label>
      <label>부서<select name="department"><option>기획부</option><option>아나운서부</option><option>기술부</option></select></label>
      <button class="app-primary" type="submit">Firebase에 추가</button>
    </form>`);
}

function openFixedModal(memberId) {
  const m = base[memberId];
  const items = m ? fixedItems(memberId, m) : [];
  modal('appModal', '', `${m?.name || ''} 고정 시간표`, `
    <div class="fixed-notice"><b>매주 반복되는 수업·고정 일정</b><span>개인 일정과 별도로 모든 주의 가능 시간 계산에서 제외됩니다.</span></div>
    <form id="fixedForm" data-form="fixed">
      <input type="hidden" name="member" value="${esc(memberId)}">
      <label>요일<select name="day">${DAYS.map((d, i) => `<option value="${i}">${d}요일</option>`).join('')}</select></label>
      <label>수업명<input name="title" value="수업" required></label>
      <div class="form-times"><label>시작<select name="start">${TIMES.map(t => `<option value="${t}">${String(t).padStart(2, '0')}:00</option>`).join('')}</select></label>
      <label>종료<select name="end">${END_TIMES.map(t => `<option value="${t}">${String(t).padStart(2, '0')}:00</option>`).join('')}</select></label></div>
      <button class="app-primary" type="submit">수업 추가</button>
    </form>
    <div class="fixed-list">${items.map(it => `<article><div><b>${DAYS[it.day]}요일 · ${esc(it.title)}</b><span>${it.start}:00–${it.end}:00</span></div><button data-act="fixed-delete" data-path="${esc(it.path)}"><i class="fa-regular fa-trash-can"></i></button></article>`).join('') || '<p>등록된 수업 시간표가 없습니다.</p>'}</div>`);
}

function openRadioModal() {
  const people = sortedPeople();
  const slots = [{ key: 'lunch', label: '점심 방송', start: 12, end: 13 }, { key: 'dinner', label: '저녁 방송', start: 18, end: 19 }];
  const endDate = radioSchedules.semesterEnd || '2026-12-21';
  const cell = (di, slot) => {
    const chosen = new Set(radioMembers(radioFor(di, slot.key)).map(x => x.id));
    return `<div class="radio-assign-cell"><div class="radio-people" data-slot="${di}:${slot.key}">${people.map(([id, m]) => `<button type="button" class="radio-pick" data-act="radio-pick" data-mid="${esc(id)}" aria-pressed="${chosen.has(id)}">${esc(m.name)}</button>`).join('')}</div></div>`;
  };
  modal('appModal', 'wide', '라디오 방송 담당 입력', `
    <form id="radioForm" class="radio-editor" data-form="radio">
      <div class="radio-editor-head"><div><b>요일과 방송 시간별 담당자</b><span>각 칸에서 담당자를 바로 선택하세요. 선택한 이름은 파란색으로 표시됩니다.</span></div>
        <label>반복 종료<input type="date" name="radioEnd" value="${endDate}"></label></div>
      <div class="radio-schedule-grid">
        <div class="radio-corner">방송</div>${DAYS.slice(0, 5).map((day, di) => `<header><b>${day}</b><small>${dates()[di].match(/\d+일/)?.[0] || ''}</small></header>`).join('')}
        ${slots.map(slot => `<div class="radio-row-label"><b>${slot.label}</b><small>${String(slot.start).padStart(2, '0')}:00–${String(slot.end).padStart(2, '0')}:00</small></div>${DAYS.slice(0, 5).map((_, di) => cell(di, slot)).join('')}`).join('')}
      </div>
      <div class="radio-mobile-days">${DAYS.slice(0, 5).map((day, di) => `<section class="radio-mobile-day"><header><b>${day}요일</b><small>${dates()[di].match(/\d+일/)?.[0] || ''}</small></header>${slots.map(slot => `<div class="radio-mobile-slot"><div><b>${slot.label}</b><small>${String(slot.start).padStart(2, '0')}:00–${String(slot.end).padStart(2, '0')}:00</small></div>${cell(di, slot)}</div>`).join('')}</section>`).join('')}</div>
      <div class="radio-actions"><span>‘이번 주 방송’은 지금 보고 있는 주에만 반영됩니다. ‘매주 반복 등록’은 위 반복 종료일까지 매주 이 담당표가 적용됩니다.</span><button class="app-secondary" type="submit" name="saveMode" value="week">이번 주 방송만 저장</button><button class="app-primary" type="submit" name="saveMode" value="semester">반복 종료일까지 매주 등록</button></div>
    </form>`);
}

function openShootModal(preset = {}) {
  const s = preset.id ? { ...shoots[preset.id] } : {};
  const date = preset.date || s.date || '', title = preset.title || s.title || '', loc = preset.location || s.location || '', note = preset.note || s.note || '';
  const pid = preset.projectId || s.projectId || '';
  const start = preset.start ?? (+s.startH || 14), end = preset.end ?? (+s.endH || 17);
  const castSet = new Set((Array.isArray(preset.cast) ? preset.cast : Array.isArray(s.cast) ? s.cast : []).map(x => x.id));
  modal('appModal', 'shoot', preset.id ? '촬영 일정 수정' : '촬영 일정 추가', `
    <form id="shootForm" class="shoot-form" data-form="shoot">
      <input type="hidden" name="id" value="${esc(preset.id || '')}">
      <label class="shoot-project-field">프로젝트<select name="projectId">${projectOptions(pid)}</select></label>
      <label class="shoot-title-field">촬영명 or S#n<input name="title" required value="${esc(title)}" placeholder="예: 인터뷰 촬영 또는 S#3"></label>
      <label class="shoot-date-field">날짜<input name="date" type="date" required value="${esc(date)}"></label>
      <div class="form-times"><label>시작<select name="start">${TIMES.map(t => `<option value="${t}" ${t === start ? 'selected' : ''}>${String(t).padStart(2, '0')}:00</option>`).join('')}</select></label>
      <label>종료<select name="end">${END_TIMES.map(t => `<option value="${t}" ${t === end ? 'selected' : ''}>${String(t).padStart(2, '0')}:00</option>`).join('')}</select></label></div>
      <div class="shoot-duration"><span>빠른 시간 설정</span><div>${[1, 2, 3, 4].map(h => `<button type="button" data-act="register-duration" data-hours="${h}">${h}시간</button>`).join('')}</div></div>
      <label class="shoot-location-field">장소<input name="location" value="${esc(loc)}" placeholder="장소 (선택)"></label>
      <div class="pick-field shoot-cast-field"><span>출연진</span><div class="radio-people" data-shoot-cast>${sortedPeople().map(([id, m]) => `<button type="button" class="radio-pick" data-act="radio-pick" data-mid="${esc(id)}" aria-pressed="${castSet.has(id) ? 'true' : 'false'}">${esc(m.name)}</button>`).join('')}</div></div>
      <label class="shoot-note-field">메모<input name="note" value="${esc(note)}" placeholder="회의 이후, NR 등 (선택)"></label>
      <div class="modal-btn-row shoot-modal-actions">${preset.id ? `<button type="button" class="app-danger" data-act="shoot-delete" data-id="${esc(preset.id)}">삭제</button>` : ''}<button class="app-primary" type="submit">저장</button></div>
    </form>`);
}

function openProjectTimelineModal(projectId) {
  const project = projects[projectId];
  if (!project) return;
  const roles = projectRoles(project);
  const items = Object.entries(shoots).map(([id, s]) => ({ id, ...s })).filter(s => s.projectId === projectId)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || (+a.startH - +b.startH));
  const roleCards = PROJECT_ROLE_DEFS.map(([key, label, hint]) => `<section><header><b>${label}</b><small>${hint}</small></header><div>${roles[key].map(x => `<span>${esc(x.name)}</span>`).join('') || '<em>미정</em>'}</div></section>`).join('');
  const timeline = items.map(s => {
    const c = (Array.isArray(s.cast) ? s.cast : []).map(x => x.name).join(', ');
    const sub = [s.location || (c ? '' : '장소 미정'), c && `출연 ${c}`, s.note].filter(Boolean).join(' · ');
    return `<button type="button" data-act="shoot-edit" data-id="${esc(s.id)}"><strong>${esc(fmtShootDate(s.date))}</strong><span><b>${esc(s.title || '촬영')}</b><small>${esc(sub || '—')}</small></span><em>${String(s.startH).padStart(2, '0')}:00–${String(s.endH).padStart(2, '0')}:00</em><i class="fa-solid fa-chevron-right"></i></button>`;
  }).join('') || '<div class="project-timeline-empty"><i class="fa-regular fa-calendar-plus"></i><b>등록된 촬영이 없습니다</b><span>첫 촬영 일정을 추가해 보세요.</span></div>';
  modal('appModal', 'wide', `${esc(project.name)} 프로젝트 기록`, `
    <div class="project-timeline-modal" style="--pc:${project.color || '#2f7df6'}">
      <div class="project-timeline-roles">${roleCards}</div>
      <div class="project-timeline-head"><div><b>전체 촬영 기록</b><span>${items.length}개 일정</span></div><button type="button" data-act="shoot-add" data-pid="${esc(projectId)}"><i class="fa-solid fa-plus"></i> 촬영 추가</button></div>
      <div class="project-timeline-list">${timeline}</div>
    </div>`);
}

function openProjectModal(editId) {
  const cur = editId ? projects[editId] : null;
  const curRoles = projectRoles(cur || {});
  const roleSets = Object.fromEntries(PROJECT_ROLE_DEFS.map(([key]) => [key, new Set(curRoles[key].map(x => x.id))]));
  const list = Object.entries(projects).sort(([, a], [, b]) => (a.createdAt || 0) - (b.createdAt || 0));
  const count = id => Object.values(shoots).filter(s => s.projectId === id).length;
  const used = new Set(Object.values(projects).map(p => p.color));
  const next = cur?.color || PROJECT_COLORS.find(c => !used.has(c)) || PROJECT_COLORS[0];
  modal('appModal', 'wide', editId ? '프로젝트 수정' : '프로젝트 관리', `
    ${editId ? '' : `<div class="project-list">${list.map(([id, p]) => {
      const roles = projectRoles(p), roleText = PROJECT_ROLE_DEFS.map(([key, label]) => `${label} ${roles[key].length}`).join(' · ');
      return `<article style="--pc:${p.color}"><span class="project-dot"></span><div><b>${esc(p.name)}</b><small>${count(id)}개 촬영 · ${roleText}</small></div>
      <button data-act="project-edit" data-pid="${esc(id)}" aria-label="수정"><i class="fa-regular fa-pen-to-square"></i></button>
      <button data-act="project-delete" data-pid="${esc(id)}" aria-label="삭제"><i class="fa-regular fa-trash-can"></i></button></article>`;
    }).join('') || '<p>등록된 프로젝트가 없습니다.</p>'}</div>`}
    <form id="projectForm" data-form="project">
      <input type="hidden" name="id" value="${esc(editId || '')}">
      <label>프로젝트 이름<input name="name" required value="${esc(cur?.name || '')}" placeholder="예: 가을 개편 특집"></label>
      <div class="pick-field"><span>색상</span><div class="color-picker"><input type="color" name="color" value="${next}" class="color-native">
        ${PROJECT_COLORS.map(c => `<button type="button" class="swatch" data-act="swatch" data-color="${c}" style="--pc:${c}" aria-label="${c}"></button>`).join('')}</div></div>
      <div class="project-role-fields">${PROJECT_ROLE_DEFS.map(([key, label, hint]) => `<section class="project-role-field"><header><b>${label}</b><small>${hint}</small></header><div class="radio-people" data-project-role="${key}">${sortedPeople().map(([id, m]) => `<button type="button" class="radio-pick" data-act="radio-pick" data-mid="${esc(id)}" aria-pressed="${roleSets[key].has(id) ? 'true' : 'false'}">${esc(m.name)}</button>`).join('')}</div></section>`).join('')}</div>
      <button class="app-primary" type="submit">${editId ? '저장' : '프로젝트 추가'}</button>
    </form>`);
}

function openPicker(mode) { // filter | required
  const checked = mode === 'required' ? state.required : (state.filter ?? new Set(Object.keys(base)));
  const groups = Object.entries(sortedPeople().reduce((out, person) => {
    const department = person[1].department || '미지정';
    (out[department] ??= []).push(person);
    return out;
  }, {}));
  modal('pickerModal', '', mode === 'required' ? '필수 참여 인원' : '분석/비교할 인원', `
    <p class="form-note">${mode === 'required' ? '반드시 참석할 인원을 선택하세요.' : '시간표 계산에 포함할 인원을 선택하세요.'}</p>
    <div class="live-picker-list picker-departments">${groups.map(([department, people]) => `<section class="picker-department"><header><div><b>${esc(department)}</b><small>${people.length}명</small></div><button data-act="picker-dept" type="button">부서 전체</button></header><div>${people.map(([id, m]) => `<label><input type="checkbox" value="${esc(id)}" ${checked.has(id) ? 'checked' : ''}><span><b>${esc(m.name)}</b><small>${esc(m.department || '미지정')}</small></span></label>`).join('')}</div></section>`).join('')}</div>
    <div class="live-picker-actions"><button data-act="picker-all">전체 선택</button><button data-act="picker-apply" data-mode="${mode}">적용</button></div>`);
}

/* ================================================================== ACTIONS */
async function saveRegistration(form) {
  const d = new FormData(form), id = d.get('member'), m = base[id];
  const day = +d.get('day'), status = d.get('status'), start = +d.get('start'), end = +d.get('end');
  if (!m || end <= start) { toast('종료 시간은 시작 시간보다 늦어야 합니다.'); return; }
  const old = memberWeek(id, m), previous = old.schedules?.[dates()[day]], explicit = personalRanges(previous);
  const chosen = { start, end };
  const schedule = {
    status: '시간별 설정', entryMode: 'exceptions',
    availableRanges: mergeRanges(status === '가능' ? [...explicit.available, chosen] : subtract(explicit.available, [chosen])),
    unavailableRanges: mergeRanges(status === '불가능' ? [...explicit.unavailable, chosen] : subtract(explicit.unavailable, [chosen])),
    memo: String(d.get('memo') || previous?.memo || ''),
  };
  // 하루가 문서 하나다. 주 단위로 묶어 쓰면 기간 조회를 못 한다.
  const target = monday(); target.setDate(target.getDate() + day);
  await saveDoc(`${personalPath(m)}/${isoOf(target)}`,
    { ...schedule, memberId: memberDocId(m), date: isoOf(target), mandatory: !!old.mandatory });
  closeModal('appModal'); toast('일정을 저장했습니다.');
}
async function saveMember(form) {
  const d = new FormData(form), name = String(d.get('name') || '').trim(), department = String(d.get('department') || '미지정');
  if (!name) return;
  const id = memberIdFor(name);
  if (Object.values(base).some(m => m.name === name)) { toast('이미 등록된 이름입니다.'); return; }
  await saveDoc(organizedMemberPath({ name, department }), cleanMemberRecord(id, { name, department, createdAt: Date.now() }));
  closeModal('appModal'); toast(`${name} 인원을 추가했습니다.`);
}
async function importMembersCsv(file) {
  if (!file) return;
  const text = await file.text();
  const rows = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.split(',').map(v => v.trim().replace(/^"|"$/g, ''))).filter(row => row.some(Boolean));
  if (!rows.length) return toast('CSV에 인원 데이터가 없습니다.');
  const header = rows[0].map(v => v.toLowerCase());
  const hasHeader = header.some(v => ['이름','name','부서','department'].includes(v));
  const nameIndex = Math.max(0, header.findIndex(v => ['이름','name'].includes(v)));
  const deptIndex = header.findIndex(v => ['부서','department'].includes(v));
  const items = (hasHeader ? rows.slice(1) : rows).map(row => ({ name: row[nameIndex] || '', department: row[deptIndex >= 0 ? deptIndex : 1] || '미지정' })).filter(x => x.name && !Object.values(base).some(m => m.name === x.name));
  if (!items.length) return toast('추가할 새 인원이 없습니다.');
  await Promise.all(items.map(({name,department}) => { const id=memberIdFor(name); return saveDoc(organizedMemberPath({name,department}), cleanMemberRecord(id,{name,department,createdAt:Date.now()})); }));
  toast(`${items.length}명을 Firebase에 추가했습니다.`);
}
async function saveFixed(form) {
  const d = new FormData(form), id = d.get('member'), m = base[id];
  const day = +d.get('day'), start = +d.get('start'), end = +d.get('end'), title = String(d.get('title') || '수업').trim();
  if (!m || !title || end <= start) { toast('수업 시간을 확인해 주세요.'); return; }
  await saveDoc(`${fixedPath(m)}/${Date.now()}`, { day, title, start, end });
  openFixedModal(id); toast('반복 수업을 추가했습니다.');
}
async function saveRadio(form) {
  const d = new FormData(form), mode = String(d.get('saveMode') || 'week');
  const slots = { lunch: { title: '점심 방송', start: 12, end: 13 }, dinner: { title: '저녁 방송', start: 18, end: 19 } };
  const picked = {};
  const radioScope = window.matchMedia('(max-width: 760px)').matches ? form.querySelector('.radio-mobile-days') : form.querySelector('.radio-schedule-grid');
  radioScope.querySelectorAll('.radio-people[data-slot]').forEach(box => {
    picked[box.dataset.slot] = [...box.querySelectorAll('.radio-pick[aria-pressed="true"]')].map(b => b.dataset.mid);
  });
  // 라디오는 문서 하나(settings/radio)다. 부분 경로에 쓰지 말고 통째로 다시 쓴다.
  const next = JSON.parse(JSON.stringify(radioSchedules || {}));
  const bucket = mode === 'semester'
    ? (next.semester ??= {})
    : ((next.weekly ??= {})[storageWeekKey()] ??= {});
  for (let day = 0; day < 5; day++) for (const [key, slot] of Object.entries(slots)) {
    const mem = (picked[`${day}:${key}`] || []).map(id => base[id] ? { id, name: base[id].name } : null).filter(Boolean);
    if (mem.length) bucket[`${DAY_KEYS[day]}_${key}`] = { members: mem, day, ...slot };
    else delete bucket[`${DAY_KEYS[day]}_${key}`];
  }
  if (mode === 'semester') next.semesterEnd = String(d.get('radioEnd') || '2026-12-21');
  await saveDoc('settings/radio', next);
  closeModal('appModal'); toast(mode === 'semester' ? '반복 종료일까지 매주 라디오 방송을 등록했습니다.' : '이번 주 라디오 방송 담당을 저장했습니다.');
}
async function saveShoot(form) {
  const d = new FormData(form), start = +d.get('start'), end = +d.get('end'), title = String(d.get('title') || '').trim();
  if (!title || end <= start) { toast('촬영명과 시간을 확인해 주세요.'); return; }
  const id = String(d.get('id') || '') || crypto.randomUUID();
  const selectedCast = [...form.querySelectorAll('[data-shoot-cast] .radio-pick[aria-pressed="true"]')]
    .map(b => b.dataset.mid).map(x => base[x] ? { id: x, name: base[x].name } : null).filter(Boolean);
  const projectId = String(d.get('projectId') || '') || null;
  const cast = withRequiredProjectCrew(projectId, selectedCast);
  await saveDoc(`shoots/${id}`, { date: String(d.get('date')), title, startH: start, endH: end, location: String(d.get('location') || ''), note: String(d.get('note') || ''), cast, castIds: cast.map(person => person.id), projectId });
  closeModal('appModal'); state.analysisSelected.clear(); toast('촬영 일정을 저장했습니다.');
}
async function saveProject(form) {
  const d = new FormData(form), id = String(d.get('id') || '') || String(Date.now());
  const name = String(d.get('name') || '').trim(), color = String(d.get('color') || PROJECT_COLORS[0]);
  const roles = Object.fromEntries(PROJECT_ROLE_DEFS.map(([key]) => [key,
    [...form.querySelectorAll(`[data-project-role="${key}"] .radio-pick[aria-pressed="true"]`)].map(b => b.dataset.mid).map(x => base[x] ? { id: x, name: base[x].name } : null).filter(Boolean)
  ]));
  const mem = [...new Map(Object.values(roles).flat().map(x => [x.id, x])).values()];
  if (!name) return;
  await saveDoc(`projects/${id}`, { ...(projects[id] || {}), name, color, roles, members: mem, createdAt: projects[id]?.createdAt || Date.now() });
  if (d.get('id')) closeModal('appModal'); else openProjectModal();
  toast('프로젝트를 저장했습니다.');
}

async function apiJson(path, options = {}) {
  const base = location.pathname === '/scheduler' || location.pathname.startsWith('/scheduler/') ? '/scheduler' : '';
  const response = await fetch(`${base}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const raw = await response.text();
  let value;
  try { value = raw ? JSON.parse(raw) : {}; }
  catch (_) {
    const html = /^\s*</.test(raw) || /text\/html/i.test(response.headers.get('content-type') || '');
    value = { error: html ? `분석 서버 경로가 응답하지 않습니다. 잠시 후 다시 시도해 주세요. (HTTP ${response.status})` : `분석 서버 응답을 읽지 못했습니다. (HTTP ${response.status})` };
  }
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

async function checkAiHealth(silent = false) {
  try {
    aiState.health = await apiJson('/api/health');
    if (!silent) toast(aiState.health.configured ? 'NVIDIA NIM 서버가 준비되었습니다.' : '서버에 NVIDIA_API_KEY 설정이 필요합니다.');
  } catch (error) {
    aiState.health = { configured: false, model: '서버 연결 실패' };
    if (!silent) reportError('AI 서버 상태 확인', error);
  }
  render();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('파일을 읽지 못했습니다.'));
    reader.readAsDataURL(file);
  });
}

async function extractAiFile(file) {
  if (!file) return;
  if (!/\.(pdf|docx|txt)$/i.test(file.name)) { toast('PDF, DOCX, TXT 파일만 선택할 수 있습니다.'); return; }
  if (file.size > 20 * 1024 * 1024) { toast('파일은 20MB 이하만 업로드할 수 있습니다.'); return; }
  aiState.file = file; aiState.extracting = true; aiState.extractedText = ''; render();
  try {
    const dataBase64 = await fileToBase64(file);
    const result = await apiJson('/api/extract', { method: 'POST', body: JSON.stringify({ filename: file.name, dataBase64 }) });
    aiState.extractedText = result.text;
    toast(`${result.characters.toLocaleString()}자 추출을 완료했습니다.`);
  } catch (error) { reportError('대본 텍스트 추출', error); }
  finally { aiState.extracting = false; render(); }
}

async function persistAiResult() {
  const job = aiState.job || aiCurrentJob(), pid = job?.projectId || aiProjectId();
  if (!pid || !job) return;
  const safeJob = JSON.parse(JSON.stringify(job));
  const previous = projects[pid]?.aiAnalysis || {};
  const scriptText = aiState.extractedText.length <= 1000000 ? aiState.extractedText : '';
  const script = aiState.extractedText ? { filename: aiState.file?.name || job.filename || '', characters: aiState.extractedText.length, text: scriptText, textStored: !!scriptText } : (previous.script || { filename: job.filename || '', characters: 0, textStored: false });
  const calculated = aiCandidates(safeJob.scenes || []);
  const candidates = calculated.items.map(slot => ({ date: slot.iso, day: slot.day, time: slot.time, available: slot.yes.map(([id]) => id), total: calculated.ids.size }));
  // 앱은 projects/{id} 의 aiAnalysis 필드를 읽는다. 하위 컬렉션이 아니라 그 필드에 쓴다.
  await mergeDoc(`projects/${pid}`, { aiAnalysis: {
    ...previous, provider: 'NVIDIA NIM', model: aiState.health?.model || '', updatedAt: new Date().toISOString(),
    elapsedMs: safeJob.elapsedMs || 0, precision: safeJob.precision || '', missingScenes: safeJob.missingScenes || 0,
    script,
    scenes: safeJob.scenes || [], characters: aiCharacters(safeJob.scenes || []), characterMappings: aiState.mappings,
    analysisJobs: { ...(previous.analysisJobs || {}), [safeJob.id]: safeJob }, activeJobId: safeJob.id,
    scheduleCandidates: candidates,
    sceneScheduleCandidates: Object.fromEntries((safeJob.scenes || []).map((scene, index) => {
      const calculatedForScene = aiCandidates([scene]);
      return [String(index), {
        sceneId: scene.sceneId || `S#${index + 1}`,
        requiredCharacters: sceneRequiredCharacters(scene),
        candidates: calculatedForScene.items.map(slot => ({
          date: slot.iso, day: slot.day, time: slot.time,
          available: slot.yes.map(([id]) => id), total: calculatedForScene.ids.size,
        })),
      }];
    })),
    job: safeJob,
  } });
}

async function resetAiProject() {
  const pid = aiProjectId();
  if (!pid) return;
  const saved = projects[pid]?.aiAnalysis || {};
  const jobIds = new Set([
    saved.activeJobId,
    saved.job?.id,
    ...Object.keys(saved.analysisJobs || {}),
    ...Object.values(saved.analysisJobs || {}).map(job => job?.id),
  ].filter(Boolean));
  clearTimeout(aiState.pollTimer);
  await Promise.all([
    mergeDoc(`projects/${pid}`, { aiAnalysis: {} }),
    ...[...jobIds].map(id => dropDoc(`analysisJobs/${id}`)),
  ]);
  aiState.file = null;
  aiState.extractedText = '';
  aiState.extracting = false;
  aiState.job = null;
  aiState.mappings = {};
  state.aiSceneIndex = 0;
  toast(`${projects[pid]?.name || '선택한 프로젝트'} 분석을 초기화했습니다.`);
  render();
}

function pollAiJob(jobId) {
  clearTimeout(aiState.pollTimer);
  aiState.pollTimer = setTimeout(async () => {
    try {
      const received = await apiJson(`/api/analysis/jobs/${jobId}?id=${encodeURIComponent(jobId)}`);
      // 프로젝트를 바꾼 동안 도착한 이전 응답은 현재 선택을 덮지 않는다.
      if (aiState.job?.id !== jobId) return;
      aiState.job = received;
      applyAutoCastMappings(aiState.job);
      render();
      if (['queued', 'running'].includes(aiState.job.status)) pollAiJob(jobId);
      else { await persistAiResult(); toast(aiState.job.status === 'completed' ? '대본 분석을 완료했습니다.' : '일부 장면 분석이 실패했습니다.'); }
    } catch (error) { reportError('분석 진행 상태 확인', error); }
  }, 1100);
}

async function startAiAnalysis() {
  if (['queued', 'running'].includes(aiState.job?.status)) { toast('진행 중인 분석이 있습니다. 완료 후 다시 시도해 주세요.'); return; }
  const pid = aiProjectId();
  if (!pid) { toast('먼저 프로젝트를 추가해 주세요.'); return; }
  if (!aiState.extractedText) { toast('먼저 대본 파일을 선택해 주세요.'); return; }
  try {
    const roles = projectRoles(projects[pid]);
    const crew = {
      planning: (roles.planning || []).map(m => m.name).filter(Boolean),
      production: (roles.production || []).map(m => m.name).filter(Boolean),
      cast: (roles.cast || []).map(m => m.name).filter(Boolean),
    };
    aiState.job = await apiJson('/api/analysis/jobs', { method: 'POST', body: JSON.stringify({ projectId: pid, filename: aiState.file?.name || projects[pid]?.aiAnalysis?.script?.filename || '대본', text: aiState.extractedText, options: aiState.options, precision: appSettings.aiAccuracy || '균형 (추천)', crew }) });
    state.aiSceneIndex = 0; render(); pollAiJob(aiState.job.id);
  } catch (error) { reportError('NVIDIA NIM 분석 시작', error); }
}

async function saveAiScene(form) {
  const job = aiCurrentJob(), index = +new FormData(form).get('index');
  if (!job?.scenes?.[index]) return;
  const d = new FormData(form), array = key => String(d.get(key) || '').split(',').map(x => x.trim()).filter(Boolean);
  job.scenes[index] = { ...job.scenes[index], sceneId: String(d.get('sceneId') || ''), location: String(d.get('location') || ''),
    interiorExterior: String(d.get('interiorExterior') || 'UNKNOWN'), dayNight: String(d.get('dayNight') || 'UNKNOWN'),
    characters: array('characters'), summary: String(d.get('summary') || ''), estimatedMinutes: +d.get('estimatedMinutes') || 0 };
  aiState.job = { ...job, projectId: aiProjectId() };
  await persistAiResult(); toast('장면 수정 내용을 저장했습니다.'); render();
}
async function copySelection() {
  const slots = [...state.selected].map(k => { const [d, t] = k.split(':').map(Number); return info(d, t); }).sort((a, b) => a.day - b.day || a.time - b.time);
  const text = slots.length ? slots.map(s => `${DAYS[s.day]} ${s.time}:00–${s.time + 1}:00 · ${s.yes.length}명 · ${s.yes.map(([, m]) => m.name).join(', ')}`).join('\n') : '선택한 시간대가 없습니다.';
  await navigator.clipboard.writeText(text).catch(() => {});
  toast('선택한 시간대를 복사했습니다.');
}

/** 개인 일정 하루치를 지운다. iso 는 'YYYY-MM-DD'.
 *  예전에는 요일 번호로 받아 보고 있는 주의 그 요일을 지웠다.
 *  그래서 다른 주 날짜를 지우라고 하면 엉뚱한 날이 날아갔다. */
async function deletePersonalDayIso(id, iso) {
  const m = base[id];
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return;
  // 하루가 문서 하나다. 그 문서만 지운다.
  await dropDoc(`${personalPath(m)}/${iso}`);
  closeModal('appModal'); toast('해당 날짜의 개인 일정을 삭제했습니다.');
}

/** 화면에서 요일 칸을 눌러 지우는 경로. 보고 있는 주의 그 요일을 지운다. */
async function deletePersonalDay(id, day) {
  const m = base[id], current = m && memberWeek(id, m);
  if (!m || !current?.schedules?.[dates()[day]]) return;
  const target = monday(); target.setDate(target.getDate() + day);
  await deletePersonalDayIso(id, isoOf(target));
}

function removeMemberFromRadio(value, id, name) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.filter(x => x?.id !== id && x?.name !== name).map(x => removeMemberFromRadio(x, id, name));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = removeMemberFromRadio(item, id, name);
  if (Array.isArray(out.members) && !out.members.length) return null;
  return out;
}

/** Firestore 는 문서를 지워도 하위 컬렉션이 남는다. 직접 비워야 한다. */
async function dropCollection(path) {
  const snap = await getDocs(collection(db, path));
  if (snap.empty) return;
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

async function deleteMemberEverywhere(id, m) {
  const docId = memberDocId(m) || id;
  // 하위 컬렉션을 먼저 비우고 국원 문서를 지운다. 순서가 바뀌면 고아 문서가 남는다.
  await dropCollection(`members/${docId}/fixedClasses`);
  await dropCollection(`members/${docId}/availability`);
  const writes = [dropDoc(`members/${docId}`)];
  const radioNext = removeMemberFromRadio(radioSchedules, id, m.name) || {};
  writes.push(saveDoc('settings/radio', radioNext));
  for (const [projectId, project] of Object.entries(projects)) {
    const roles = Object.fromEntries(PROJECT_ROLE_DEFS.map(([key]) => [key, (projectRoles(project)[key] || []).filter(x => x.id !== id && x.name !== m.name)]));
    const members = [...new Map(Object.values(roles).flat().map(x => [x.id, x])).values()];
    writes.push(saveDoc(`projects/${projectId}`, { ...project, roles, members }));
  }
  await Promise.all(writes);
}

async function deleteProjectEverywhere(projectId) {
  // 빈 id 를 붙이면 프로젝트 노드 전체가 지워진다.
  const key = String(projectId || '').trim();
  if (!key) throw new Error('삭제할 프로젝트를 찾지 못했습니다.');
  const writes = [dropDoc(`projects/${key}`)];
  for (const [shootId, shoot] of Object.entries(shoots)) if (shoot.projectId === projectId) {
    writes.push(saveDoc(`shoots/${shootId}`, { ...shoot, projectId: null }));
  }
  await Promise.all(writes);
}

/* ================================================================== EVENTS */
function changeWeek(offset) {
  state.weekOffset = offset; syncWeek();
  state.selected.clear(); state.filter = null;
  state.required = new Set();
  render();
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const d = el.dataset;
  // 모든 버튼이 여기를 지난다. 무엇을 눌렀는지 남겨 두면 오류를 되짚을 수 있다.
  logEvent('act', d.id || d.tab || d.day ? `${act} (${d.id || d.tab || d.day})` : act);

  switch (act) {
    case 'tab':
      if (d.tab === 'ai') {
        const pid = aiProjectId();
        aiState.mappings = { ...(projects[pid]?.aiAnalysis?.characterMappings || {}), ...aiState.mappings };
        if (!aiState.health) checkAiHealth(true);
      }
      setState({ view: d.tab, weekMode: 'week' }); return;
    case 'mobile-day': setState({ mobileDay: Math.max(0, Math.min(6, +d.day)) }); return;
    case 'mobile-week-open': setState({ mobileDay: Math.max(0, Math.min(6, +d.day)), mobileWeekDetail: true }); return;
    case 'mobile-week-back': setState({ mobileWeekDetail: false }); return;
    case 'mobile-shoot-mode': setState({ mobileShootMode: d.mode || 'day', mobileShootExpanded: '' }); return;
    case 'shoot-status': setState({ shootStatusFilter: d.status || 'all' }); return;
    case 'mobile-shoot-expand':
      if (e.target.closest('[data-act="shoot-edit"]')) return;
      setState({ mobileShootExpanded: state.mobileShootExpanded === d.id ? '' : d.id }); return;
    case 'open-settings': setState({ view: 'settings' }); return;
    case 'data-reload': location.reload(); return;
    case 'member-filter': setState({ memberFilter: d.filter || 'all' }); return;
    case 'member-csv': document.getElementById('memberCsvInput')?.click(); return;

    /* week nav (all prefixes) */
    case 'wk-prev': case 'an-prev': case 'sh-prev': case 'pe-prev': case 'mh-prev': changeWeek(state.weekOffset - 1); return;
    case 'wk-next': case 'an-next': case 'sh-next': case 'pe-next': case 'mh-next': changeWeek(state.weekOffset + 1); return;
    case 'wk-today': case 'an-today': case 'sh-today': case 'pe-today': changeWeek(0); return;

    case 'weekmode': setState({ weekMode: d.mode }); return;

    case 'slot': {
      const key = `${d.day}:${d.time}`;
      if (state.rangeMode) {
        if (!state.rangeStart) { state.selected.clear(); state.selected.add(key); state.rangeStart = { d: +d.day, t: +d.time }; }
        else if (state.rangeStart.d === +d.day) {
          for (let x = Math.min(state.rangeStart.t, +d.time); x <= Math.max(state.rangeStart.t, +d.time); x++) state.selected.add(`${d.day}:${x}`);
          state.rangeMode = false; state.rangeStart = null;
        } else { state.selected.clear(); state.selected.add(key); state.rangeStart = { d: +d.day, t: +d.time }; }
      } else state.selected.has(key) ? state.selected.delete(key) : state.selected.add(key);
      render(); return;
    }
    case 'quick':
      if (d.quick === 'filter') openPicker('filter');
      else if (d.quick === 'required') openPicker('required');
      else if (d.quick === 'ai') setState({ view: 'ai' });
      else if (d.quick === 'range') { state.rangeMode = true; state.rangeStart = null; state.selected.clear(); render(); }
      else if (d.quick === 'copy') copySelection();
      else if (d.quick === 'clear') { state.selected.clear(); state.rangeMode = false; state.rangeStart = null; render(); }
      return;
    case 'open-register': openRegisterModal(); return;

    /* analysis */
    case 'analysis-start': setState({ analysisStep: 1 }); return;
    case 'analysis-run': {
      const ids = new Set([...document.querySelectorAll('#app .analysis-choose input:checked')].map(x => x.value));
      setState({ analysisStep: 2, analysisPicked: ids, analysisSelected: new Set() });
      return;
    }
    case 'analysis-again': setState({ analysisStep: 1 }); return;
    case 'dept-toggle': {
      const inputs = [...el.closest('section').querySelectorAll('input')];
      const all = inputs.every(x => x.checked);
      inputs.forEach(x => x.checked = !all);
      return;
    }
    case 'aslot': {
      const key = `${d.day}:${d.time}`;
      state.analysisSelected.has(key) ? state.analysisSelected.delete(key) : state.analysisSelected.add(key);
      render(); return;
    }
    case 'analysis-sel-clear': state.analysisSelected.clear(); render(); return;
    case 'analysis-shoot-add': {
      const its = [...state.analysisSelected].map(k => { const [dd, tt] = k.split(':').map(Number); return { day: dd, time: tt }; }).sort((a, b) => a.day - b.day || a.time - b.time);
      if (!its.length) { toast('먼저 시간대를 선택하세요.'); return; }
      openShootModal({ date: analysisDate(its[0].day), start: its[0].time, end: its[its.length - 1].time + 1 });
      return;
    }
    case 'analysis-copy': {
      const text = [...document.querySelectorAll('#app .analysis-list > div')].map(x => x.textContent.trim()).join('\n');
      navigator.clipboard.writeText(text).catch(() => {}); toast('복사했습니다.'); return;
    }

    /* AI script analysis */
    case 'ai-file': document.getElementById('aiFileInput')?.click(); return;
    case 'ai-health': checkAiHealth(); return;
    case 'ai-start': startAiAnalysis(); return;
    case 'ai-reset': {
      const pid = aiProjectId();
      if (!pid || !projects[pid]?.aiAnalysis) return;
      if (!confirm(`${projects[pid]?.name || '선택한 프로젝트'}의 대본 분석 결과만 초기화할까요?\n다른 프로젝트와 촬영 일정은 유지됩니다.`)) return;
      resetAiProject().catch(error => reportError('프로젝트 분석 초기화', error));
      return;
    }
    case 'ai-scene': setState({ aiSceneIndex: +d.i }); return;
    case 'ai-retry': {
      const job = aiCurrentJob();
      if (!job?.id) return;
      apiJson(`/api/analysis/jobs/${job.id}/retry/${d.i}?id=${encodeURIComponent(job.id)}&index=${encodeURIComponent(d.i)}`, { method: 'POST', body: '{}' }).then(() => { pollAiJob(job.id); toast('실패한 묶음을 다시 분석합니다.'); }).catch(error => reportError('장면 재분석', error));
      return;
    }
    case 'ai-candidate': {
      const pid = aiProjectId();
      const job = aiCurrentJob();
      const scene = (job?.scenes || projects[pid]?.aiAnalysis?.scenes || [])[state.aiSceneIndex];
      const cast = sceneRequiredCharacters(scene)
        .map(resolveMemberId)
        .filter((id, index, ids) => id && base[id] && ids.indexOf(id) === index)
        .map(id => ({ id, name: base[id].name }));
      openShootModal({
        projectId: pid,
        date: analysisDate(+d.day),
        start: +d.time,
        end: +d.time + 1,
        title: scene?.sceneId || '촬영',
        location: scene?.location || '',
        note: scene?.title || '',
        cast,
      });
      return;
    }

    /* shoot */
    case 'shoot-view': setState({ shootView: d.sv, shootOpen: false }); return;
    case 'shoot-filter': setState({ shootProjectFilter: d.pid || 'all' }); return;
    case 'shoot-slide': {
      const i = +d.i;
      setState(s => ({ shootOpen: i === s.shootSlide ? !s.shootOpen : true, shootSlide: i }));
      return;
    }
    case 'shoot-project-detail':
      state.shootSlide = Number.isFinite(+d.i) ? +d.i : state.shootSlide;
      state.shootOpen = false;
      render();
      openProjectTimelineModal(d.pid);
      return;
    case 'shoot-machine-prev': {
      const count = Object.keys(projects).length;
      if (count) setState(s => ({ shootSlide: (s.shootSlide - 1 + count) % count, shootOpen: false }));
      return;
    }
    case 'shoot-machine-next': {
      const count = Object.keys(projects).length;
      if (count) setState(s => ({ shootSlide: (s.shootSlide + 1) % count, shootOpen: false }));
      return;
    }
    case 'shoot-edit': if (d.id) openShootModal({ id: d.id }); return;
    case 'shoot-add': openShootModal({
      ...(d.pid ? { projectId: d.pid } : {}),
      ...(d.date ? { date: d.date } : {}),
      ...(d.start ? { start: +d.start } : {}),
      ...(d.end ? { end: +d.end } : {}),
    }); return;
    case 'shoot-delete':
      if (confirm('이 촬영 일정을 삭제할까요?')) dropDoc(`shoots/${d.id}`).then(() => { closeModal('appModal'); toast('촬영 일정을 삭제했습니다.'); }).catch(error => reportError('촬영 일정 삭제', error));
      return;
    case 'project-open': openProjectModal(); return;
    case 'project-edit': openProjectModal(d.pid); return;
    case 'project-delete': {
      const inModal = !!el.closest('.app-modal');
      if (confirm('이 프로젝트를 삭제할까요? 묶인 촬영 일정은 미분류로 남습니다.'))
        deleteProjectEverywhere(d.pid).then(() => { if (inModal) openProjectModal(); toast('프로젝트를 삭제했습니다.'); }).catch(error => reportError('프로젝트 삭제', error));
      return;
    }

    /* personal / settings */
    case 'department-toggle': {
      const next = new Set(state.personalOpenDepts);
      next.has(d.dept) ? next.delete(d.dept) : next.add(d.dept);
      setState({ personalOpenDepts: next }); return;
    }
    case 'settings-department-toggle': {
      const next = new Set(state.settingsOpenDepts);
      next.has(d.dept) ? next.delete(d.dept) : next.add(d.dept);
      setState({ settingsOpenDepts: next }); return;
    }
    case 'person-select': {
      const person = sortedPeople()[+d.i];
      const next = new Set(state.personalOpenDepts);
      if (person?.[1]?.department) next.add(person[1].department);
      setState({ personalActive: +d.i, personalOpenDepts: next }); return;
    }
    case 'personal-cell': openRegisterModal(d.id || '', {
      ...(d.day != null ? { day: +d.day } : {}),
      ...(d.time != null ? { start: +d.time, end: +d.time + 1 } : {}),
    }); return;
    case 'personal-day-delete':
      if (confirm('이 날짜에 직접 등록한 개인 일정을 삭제할까요?')) deletePersonalDay(d.id, +d.day).catch(error => reportError('개인 일정 삭제', error));
      return;
    case 'member-add': openMemberModal(); return;
    case 'member-delete': {
      const m = base[d.id];
      if (m && confirm(`${m.name} 인원과 연결된 개인 일정·고정 일정·담당 정보를 함께 삭제할까요?`)) deleteMemberEverywhere(d.id, m).then(() => toast('인원과 연결된 데이터를 삭제했습니다.')).catch(error => reportError('인원 삭제', error));
      return;
    }
    case 'fixed-open': openFixedModal(d.id); return;
    case 'fixed-delete':
      // 라디오 방송은 다른 문서에 들어 있다. 잘못된 경로로 지우지 않는다.
      if (!String(d.path || '').startsWith('members/')) { toast('라디오 방송은 라디오 편성에서 수정하세요.'); return; }
      if (confirm('이 수업 시간을 삭제할까요?')) dropDoc(d.path).then(() => { closeModal('appModal'); toast('수업 시간을 삭제했습니다.'); }).catch(error => reportError('고정 시간표 삭제', error));
      return;
    case 'radio-open': openRadioModal(); return;
    case 'admin-open': location.href = '/admin/?from=scheduler'; return;
    case 'structure-migrate':
      toast('Firestore 로 옮긴 뒤로는 구조 정리가 필요 없습니다.');
      return;

    /* modals */
    case 'modal-close': closeModal(d.modal); return;
    case 'register-choice': {
      const form = el.closest('form');
      const input = form?.querySelector(`input[name="${d.name}"]`);
      if (!input) return;
      input.value = d.value;
      form.querySelectorAll(`[data-act="register-choice"][data-name="${d.name}"]`).forEach(x => x.setAttribute('aria-pressed', x === el ? 'true' : 'false'));
      return;
    }
    case 'register-duration': {
      const form = el.closest('form');
      const start = form?.elements.start, end = form?.elements.end;
      if (!start || !end) return;
      if (d.hours === 'all') { start.value = '9'; end.value = '23'; }
      else end.value = String(Math.min(23, +start.value + +d.hours));
      return;
    }
    case 'radio-pick': el.setAttribute('aria-pressed', el.getAttribute('aria-pressed') !== 'true'); return;
    case 'swatch': {
      const inp = el.parentElement.querySelector('.color-native');
      if (inp) inp.value = d.color;
      el.parentElement.querySelectorAll('.swatch').forEach(x => x.classList.toggle('is-active', x === el));
      return;
    }
    case 'picker-all': document.querySelectorAll('#pickerModal input').forEach(x => x.checked = true); return;
    case 'picker-dept': {
      const inputs = [...el.closest('.picker-department').querySelectorAll('input')];
      const shouldCheck = !inputs.every(x => x.checked);
      inputs.forEach(x => x.checked = shouldCheck);
      return;
    }
    case 'picker-apply': {
      const ids = new Set([...document.querySelectorAll('#pickerModal input:checked')].map(x => x.value));
      if (d.mode === 'required') state.required = ids;
      else state.filter = ids.size === Object.keys(base).length ? null : ids;
      closeModal('pickerModal'); render();
      return;
    }
  }
}, false);

// click on modal backdrop closes
document.addEventListener('click', e => {
  if (e.target.classList.contains('app-modal')) e.target.classList.remove('open');
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeAllModals(); return; }
  if (e.key !== 'Tab') return;
  const modal = document.querySelector('.app-modal.open');
  if (!modal) return;
  const focusable = [...modal.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(x => !x.disabled && x.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable.at(-1);
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

document.addEventListener('submit', e => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const fns = { register: saveRegistration, member: saveMember, fixed: saveFixed, radio: saveRadio, shoot: saveShoot, project: saveProject, 'ai-scene': saveAiScene };
  fns[form.dataset.form]?.(form).catch(error => reportError(`${form.dataset.form} 저장`, error));
});

document.addEventListener('change', e => {
  const el = e.target;
  if (el.id === 'memberCsvInput') { importMembersCsv(el.files?.[0]).catch(error => reportError('CSV 인원 가져오기', error)); return; }
  if (el.matches('[data-ai-option]')) { aiState.options[el.dataset.aiOption] = el.checked; return; }
  if (el.id === 'aiFileInput') { extractAiFile(el.files?.[0]); return; }
  if (el.matches('[data-act="ai-project"]')) {
    state.aiProjectId = el.value; state.aiSceneIndex = 0; aiState.job = null;
    aiState.mappings = { ...(projects[el.value]?.aiAnalysis?.characterMappings || {}) }; render(); return;
  }
  if (el.matches('[data-act="ai-mapping"]')) {
    aiState.mappings[el.dataset.character] = el.value;
    persistAiResult().catch(error => reportError('등장인물 매칭 저장', error)); render();
  }
  if (el.matches('[data-act="person-select-select"]')) {
    setState({ personalActive: Math.max(0, +el.value || 0) });
  }
});

document.addEventListener('input', e => {
  if (e.target.id !== 'memberSearch') return;
  state.memberQuery = e.target.value;
  const pos = e.target.selectionStart;
  render();
  const next = document.getElementById('memberSearch');
  if (next) { next.focus(); next.setSelectionRange(pos, pos); }
});

document.addEventListener('dragover', e => {
  if (e.target.closest('.ai-drop')) e.preventDefault();
});
document.addEventListener('drop', e => {
  if (!e.target.closest('.ai-drop')) return;
  e.preventDefault(); extractAiFile(e.dataTransfer?.files?.[0]);
});

/* ================================================================== FIRESTORE SUBSCRIPTIONS */
const rowsOf = snap => snap.docs.map(d => ({ id: d.id, data: d.data() || {} }));
// 하위 컬렉션(collectionGroup)은 어느 국원 것인지 부모 경로에서 읽는다.
const subRowsOf = snap => snap.docs.map(d => ({
  id: d.id, memberId: d.ref.parent.parent?.id || '', data: d.data() || {},
}));

// 촬영은 castIds(고정 ID)만 저장한다. 이름은 인원 목록에서 그때그때 붙인다.
const hydrateShoot = (id, data) => ({
  ...data, id,
  cast: (Array.isArray(data.castIds) ? data.castIds : (Array.isArray(data.cast) ? data.cast : []))
    .map(value => { const mid = typeof value === 'string' ? value : value?.id;
      return mid && base[mid] ? { id: mid, name: base[mid].name } : value?.name ? value : null; }).filter(Boolean),
});
// 프로젝트 역할은 Firestore 에 고정 ID 배열로 저장된다. 화면에서는 기존처럼 {id,name}으로 쓴다.
const hydrateProject = data => {
  const person = value => {
    const mid = typeof value === 'string' ? value : value?.id;
    if (mid && base[mid]) return { id: mid, name: base[mid].name };
    return value?.name ? { id: mid || '', name: value.name } : null;
  };
  const roles = Object.fromEntries(PROJECT_ROLE_DEFS.map(([key]) =>
    [key, (Array.isArray(data.roles?.[key]) ? data.roles[key] : []).map(person).filter(Boolean)]));
  const memberSource = Array.isArray(data.memberIds) ? data.memberIds : (Array.isArray(data.members) ? data.members : []);
  return { ...data, roles, members: memberSource.map(person).filter(Boolean) };
};
let rawShoots = [], rawProjects = [], rawFixed = [], rawPersonal = [];
const applyShoots = () => { shoots = Object.fromEntries(rawShoots.map(r => [r.id, hydrateShoot(r.id, r.data)])); };
const applyProjects = () => { projects = Object.fromEntries(rawProjects.map(r => [r.id, hydrateProject(r.data)])); };

onSnapshot(collection(db, 'members'), snap => {
  base = normalizeOrganizedMembers(rowsOf(snap));
  // 국원 이름/ID 가 바뀌면 이름으로 묶던 것들을 다시 만들어야 한다.
  fixedSchedules = normalizeOrganizedFixed(rawFixed);
  allWeeks = normalizeOrganizedPersonal(rawPersonal);
  applyShoots();
  applyProjects();
  syncWeek();
  markLoaded('members'); render();
}, error => failDataLoad('members', '인원 불러오기', error));

onSnapshot(collectionGroup(db, 'fixedClasses'), snap => {
  rawFixed = subRowsOf(snap);
  fixedSchedules = normalizeOrganizedFixed(rawFixed);
  markLoaded('fixedSchedules'); render();
}, error => failDataLoad('fixedSchedules', '고정 시간표 불러오기', error));

onSnapshot(collectionGroup(db, 'availability'), snap => {
  rawPersonal = subRowsOf(snap);
  allWeeks = normalizeOrganizedPersonal(rawPersonal); syncWeek();
  // 필수 인원은 사용자가 직접 선택하는 화면 상태다. 저장된 mandatory 값으로 자동 선택하지 않는다.
  state.required = new Set();
  markLoaded('weeks'); render();
}, error => failDataLoad('weeks', '개인 일정 불러오기', error));

onSnapshot(collection(db, 'shoots'), snap => {
  rawShoots = rowsOf(snap); applyShoots();
  markLoaded('shoots'); render();
}, error => failDataLoad('shoots', '촬영 일정 불러오기', error));

onSnapshot(collection(db, 'projects'), snap => {
  rawProjects = rowsOf(snap); applyProjects();
  markLoaded('projects'); render();
}, error => failDataLoad('projects', '프로젝트 불러오기', error));

onSnapshot(collection(db, 'settings'), snap => {
  const map = Object.fromEntries(rowsOf(snap).map(r => [r.id, r.data]));
  appSettings = map.app || {};
  radioSchedules = withoutMeta(map.radio || {});
  markLoaded('radioSchedules'); render();
}, error => failDataLoad('settings', '설정 불러오기', error));

const mobileViewport = window.matchMedia('(max-width: 760px)');
let wasMobileViewport = mobileViewport.matches;
mobileViewport.addEventListener('change', event => {
  if (event.matches === wasMobileViewport) return;
  wasMobileViewport = event.matches;
  if (!event.matches && state.view === 'home') state.view = 'week';
  render();
});

render();
checkAiHealth(true);
setTimeout(() => {
  if (!pendingData.size) return;
  for (const key of pendingData) dataLoadFailures.set(key, `${key} 연결 지연`);
  pendingData.clear();
  finishInitialLoad();
  render();
}, 12000);

/* ================================================================== DESIGN HANDOFF ENGINE */
// Same-origin desktop/mobile handoff screens consume this API. Reads and writes
// continue to use the original Firebase/NVIDIA implementation above.
/* 스냅샷 캐시: 폴링(약 1초)마다 전체 데이터를 직렬화하면 프레임이 끊긴다.
   revision 문자열이 그대로면 이전에 만든 객체를 그대로 돌려준다. */
let snapshotCache = null, snapshotRevision = null;

window.HNUBS_ENGINE = {
  snapshot() {
    const revision = JSON.stringify([
      base, week, fixedSchedules, projects, shoots, storageWeekKey(),
      aiState.job, aiState.extracting, aiState.extractedText.length, aiState.health, pendingData.size,
      aiState.planOptions,   // 묶음 조건이 바뀌면 다시 계산해야 한다
      aiState.mappings,
      appSettings, state.aiProjectPicked,
      state.weekOffset,
      state.filter instanceof Set ? [...state.filter] : null,
      state.required instanceof Set ? [...state.required] : null,
    ]);
    if (snapshotCache && revision === snapshotRevision) return snapshotCache;
    const memberEntries = Object.entries(members());
    const weekDates = dates();
    const memberAvailability = new Map(memberEntries.map(([id, m]) => [id,
      DAYS.map((_, day) => { const spans = ranges(m, day); return TIMES.map(time => spans.some(r => +r.start <= time && +r.end >= time + 1)); })
    ]));
    const compareSet = state.filter instanceof Set ? state.filter : null;
    const availEntries = compareSet ? memberEntries.filter(([id]) => compareSet.has(id)) : memberEntries;
    const availability = DAYS.map((_, day) => TIMES.map((_, t) => availEntries.filter(([id]) => memberAvailability.get(id)[day][t]).length));
    // 시간대별 가능 인원 이름 — Air(챗봇)가 "다 같이 되는 시간"을 답할 수 있게 한다.
    const availableNames = DAYS.map((_, day) => TIMES.map((_, t) =>
      availEntries.filter(([id]) => memberAvailability.get(id)[day][t]).map(([, m]) => m.name || '')));
    const memberItems = memberEntries.map(([id, m]) => ({
      id,
      name: m.name || '',
      department: m.department || '미지정',
      position: m.position || m.role || '',
      availableHours: memberAvailability.get(id).flat().filter(Boolean).length,
      schedules: m.schedules || {},
      fixedSchedule: m.fixedSchedule || {},
    }))
      /* 인원 목록은 여기서 한 번만 정렬한다. 화면마다 따로 정렬하면
         개인 일정 관리·선택 목록처럼 빠뜨리는 곳이 생긴다.
         부서는 기획-아나운서-기술 순, 부서 안은 이름 가나다 순. */
      .sort((x, y) => {
        const order = ['기획부', '아나운서부', '기술부'];
        const rank = d => { const i = order.findIndex(o => String(d).startsWith(o.replace('부', ''))); return i < 0 ? 99 : i; };
        return rank(x.department) - rank(y.department)
          || String(x.department).localeCompare(String(y.department), 'ko')
          || String(x.name).localeCompare(String(y.name), 'ko');
      });
    const currentAiJob = aiCurrentJob();
    const currentScenes = currentAiJob?.scenes || [];
    const currentCandidates = currentAiJob ? aiCandidates(currentScenes) : { ids: new Set(), items: [] };
    const sceneSchedule = currentAiJob
      ? buildSceneSchedule(currentScenes, { includeConfirmed: !!aiState.planOptions?.includeConfirmed })
      : { groups: [], unassigned: [], confirmed: [], totals: { all: 0, confirmed: 0, planning: 0, unassigned: 0, conflicts: 0, days: 0 } };
    const sceneCandidates = currentScenes.map((scene, index) => {
      const result = aiCandidates([scene]);
      const roles = projectRoles(projects[aiProjectId()] || {});
      const rolePeople = key => (roles[key] || []).map(person => ({ id: person.id, name: base[person.id]?.name || person.name || '' })).filter(person => person.id && person.name);
      const projectCrew = { planning: rolePeople('planning'), production: rolePeople('production') };
      return {
        index,
        scene,
        projectCrew,
        requiredPeople: (() => {
          const map = { ...(projects[aiProjectId()]?.aiAnalysis?.characterMappings || {}), ...aiState.mappings };
          const cast = sceneRequiredCharacters(scene).map(character => {
            const id = map[character];
            return { character, id: id || '', name: base[id]?.name || '', role: '출연' };
          }).filter(person => person.character);
          // 기획·촬영 담당은 씬마다 기본 포함한다.
          const crew = [...projectCrew.planning.map(person => ({ ...person, character: person.name, role: '스태프', crewRole: '기획' })),
            ...projectCrew.production.map(person => ({ ...person, character: person.name, role: '스태프', crewRole: '촬영/편집' }))];
          const seen = new Set();
          return [...cast, ...crew].filter(p => {
            const key = p.id || p.character;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        })(),
        candidates: result.items.map(slot => ({
          day: slot.day,
          time: slot.time,
          available: slot.yes.map(([id, person]) => ({ id, name: person.name })),
          total: result.ids.size,
        })),
      };
    });
    snapshotRevision = revision;
    snapshotCache = JSON.parse(JSON.stringify({
      revision,
      settings: appSettings,
      ready: pendingData.size === 0,
      failures: [...dataLoadFailures.entries()],
      weekOffset: state.weekOffset,
      weekLabel: `${weekDates[0]} - ${weekDates[6]}`,
      dates: weekDates,
      dateIsos: DAYS.map((_, day) => analysisDate(day)),
      members: memberItems,
      memberCount: memberItems.length,
      compareMembers: compareSet ? [...compareSet] : [],
      requiredMembers: state.required instanceof Set ? [...state.required] : [],
      availability,
      availableNames,
      hours: TIMES,
      projects: Object.entries(projects).map(([id, p]) => ({ id, ...p })),
      shoots: Object.entries(shoots).map(([id, s]) => ({ id, ...s })),
      ai: {
        health: aiState.health,
        // 사용자가 실제로 고른 값만 내보낸다. aiProjectId() 는 첫 프로젝트로 자동 대체하므로 쓰지 않는다.
        projectId: projects[state.aiProjectPicked] ? state.aiProjectPicked : '',
        fileName: aiState.file?.name || projects[aiProjectId()]?.aiAnalysis?.script?.filename || '',
        // 이번 세션에서 실제로 업로드·추출이 끝난 대본이 있는지. 분석 시작 가능 여부의 진짜 기준.
        hasScript: !!aiState.extractedText,
        extracting: aiState.extracting,
        extractedCharacters: aiState.extractedText.length,
        job: currentAiJob,
        sceneCount: currentScenes.length,
        sceneCandidates,
        sceneGroups: sceneSchedule.groups,
        confirmedScenes: sceneSchedule.confirmed,
        totals: sceneSchedule.totals,
        unassignedScenes: sceneSchedule.unassigned,
        candidates: currentCandidates.items.map(slot => ({
          day: slot.day, time: slot.time, available: slot.yes.map(([id, person]) => ({ id, name: person.name })), total: currentCandidates.ids.size,
        })),
      },
    }));
    return snapshotCache;
  },
  setWeekOffset(value) {
    state.weekOffset = Number(value) || 0;
    syncWeek();
    render();
  },
  async saveProject(record = {}) {
    const id = record.id || String(Date.now());
    const name = String(record.name || '').trim();
    if (!name) throw new Error('프로젝트 이름을 입력해 주세요.');
    await saveDoc(`projects/${id}`, {
      ...(projects[id] || {}), name, color: record.color || PROJECT_COLORS[0],
      roles: record.roles || projectRoles(projects[id]),
      members: record.members || projects[id]?.members || [],
      createdAt: projects[id]?.createdAt || Date.now(),
    });
    return id;
  },
  async deleteProject(id) { await deleteProjectEverywhere(id); },
  /** 이 시간에 같은 사람이 다른 촬영에 잡혀 있는지 본다.
   *  시간만 겹치는 건 충돌이 아니다. 빈 배열이면 그냥 등록해도 된다. */
  shootConflicts(record = {}) {
    return shootConflicts(record);
  },
  async saveShoot(record = {}) {
    const id = record.id || crypto.randomUUID();
    if (!record.title || !(+record.endH > +record.startH)) throw new Error('촬영명과 시간을 확인해 주세요.');
    // 기존 기록 위에 덮어쓴다. 이렇게 하지 않으면 화면이 모르는 필드(scenes 등)가 사라진다.
    const previous = record.id ? (shoots[record.id] || {}) : {};
    const pick = (key, fallback) => (record[key] === undefined ? (previous[key] ?? fallback) : record[key]);
    const projectId = pick('projectId', null) || null;
    const cast = withRequiredProjectCrew(projectId, pick('cast', []));
    await saveDoc(`shoots/${id}`, {
      ...previous,
      date: record.date, title: record.title, startH: +record.startH, endH: +record.endH,
      location: pick('location', ''), note: pick('note', ''), cast, castIds: cast.map(person => person.id),
      // 어떤 씬을 확정했는지. 이게 있어야 재분석에서 확정 씬을 뺀다.
      sceneIds: pick('sceneIds', []),
      projectId,
    });
    return id;
  },
  async deleteShoot(id) {
    // 빈 id 를 그대로 붙이면 촬영일정 노드 전체가 지워진다.
    const key = String(id || '').trim();
    if (!key) throw new Error('삭제할 촬영 일정을 찾지 못했습니다.');
    await dropDoc(`shoots/${key}`);
  },
  async addPersonalSchedule(record = {}) {
    const name = String(record.memberName || '').trim();
    const memberEntry = Object.entries(base).find(([, person]) => person.name === name);
    if (!memberEntry) throw new Error(`등록 인원에서 ${name || '해당 이름'}을 찾지 못했습니다.`);
    const [id, person] = memberEntry;
    const date = new Date(`${record.date}T12:00:00`);
    const start = Number(record.start), end = Number(record.end);
    const status = record.status === '불가능' ? '불가능' : record.status === '가능' ? '가능' : '';
    /* 2026-02-31 같은 없는 날짜는 JS 가 3월 3일로 굴려 버린다. 그대로 저장하면
       사용자가 말한 적 없는 날에 일정이 생긴다. 실재하는 날짜인지까지 확인한다. */
    const asked = String(record.date || '').trim();
    const real = /^\d{4}-\d{2}-\d{2}$/.test(asked) && isoOf(date) === asked;
    if (Number.isNaN(date.getTime()) || !real || !status || !(start >= 0 && end <= 24 && end > start)) throw new Error('이름, 날짜, 시간 또는 가능 여부를 확인해 주세요.');
    const iso = isoOf(date);
    const dayLabel = dayLabelOf(date);
    const targetWeekKey = weekKeyFromLabel(dayLabelOf(weekStartOf(iso)));
    const old = allWeeks[targetWeekKey]?.[id] || {};
    const previous = old.schedules?.[dayLabel];
    const explicit = personalRanges(previous);
    const chosen = { start, end };
    const schedule = {
      status: '시간별 설정', entryMode: 'exceptions',
      availableRanges: mergeRanges(status === '가능' ? [...explicit.available, chosen] : subtract(explicit.available, [chosen])),
      unavailableRanges: mergeRanges(status === '불가능' ? [...explicit.unavailable, chosen] : subtract(explicit.unavailable, [chosen])),
      memo: String(record.memo || previous?.memo || 'Air(에어)에서 등록'),
    };
    await saveDoc(`${personalPath(person)}/${iso}`,
      { ...schedule, memberId: memberDocId(person), date: iso, mandatory: !!old.mandatory });
    return { memberName: person.name, date: dayLabel, status, start, end };
  },
  async deletePersonalScheduleDay(record = {}) {
    const name = String(record.memberName || '').trim();
    const memberEntry = Object.entries(base).find(([, person]) => person.name === name);
    if (!memberEntry) throw new Error(`등록 인원에서 ${name || '해당 이름'}을 찾지 못했습니다.`);
    const [id] = memberEntry;
    const date = new Date(`${record.date}T12:00:00`);
    if (Number.isNaN(date.getTime())) throw new Error('날짜를 확인해 주세요.');
    // 요일이 아니라 그 날짜를 지운다. 다른 주 날짜도 정확히 지워진다.
    await deletePersonalDayIso(id, `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`);
  },
  /* ----- 고정 시간표(수업) ----- */
  /** 한 사람의 고정 수업을 추가한다. day 는 0=월 … 6=일. */
  async saveFixedClass(record = {}) {
    const name = String(record.memberName || '').trim();
    const entry = Object.entries(base).find(([, m]) => m.name === name);
    if (!entry) throw new Error(`등록 인원에서 ${name || '해당 이름'}을 찾지 못했습니다.`);
    const [, member] = entry;
    const day = Number(record.day), start = Number(record.start), end = Number(record.end);
    const title = String(record.title || '수업').trim();
    if (!Number.isInteger(day) || day < 0 || day > 6) throw new Error('요일을 확인해 주세요.');
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) throw new Error('시간을 확인해 주세요.');
    if (!title) throw new Error('과목명을 입력해 주세요.');
    const id = String(record.id || Date.now());
    await saveDoc(`${fixedPath(member)}/${id}`, { day, title, start, end });
    return id;
  },
  async deleteFixedClass(memberName, id) {
    const entry = Object.entries(base).find(([, m]) => m.name === String(memberName).trim());
    if (!entry) throw new Error('등록 인원을 찾지 못했습니다.');
    // 빈 id 를 붙이면 그 인원의 고정 수업이 통째로 지워진다.
    const key = String(id || '').trim();
    if (!key) throw new Error('삭제할 수업 시간을 찾지 못했습니다.');
    await dropDoc(`${fixedPath(entry[1])}/${key}`);
  },

  /* ----- 설정 · 관리자 ----- */
  async saveSettings(patch = {}) {
    const next = { ...appSettings, ...patch };
    await saveDoc('settings/app', next);
    return next;
  },
  async setMemberRole(name, role) {
    const entry = Object.entries(base).find(([, m]) => m.name === String(name).trim());
    if (!entry) throw new Error(`등록 인원에서 ${name}을 찾지 못했습니다.`);
    const [id, member] = entry;
    await saveDoc(organizedMemberPath(member), cleanMemberRecord(id, { ...member, role: String(role || '') }));
    return { name: member.name, role };
  },
  /** 내보내기 파일(JSON)을 그대로 되돌린다. 지정한 영역만 덮어쓴다. */
  async importData(payload = {}) {
    if (!payload || typeof payload !== 'object') throw new Error('가져올 데이터 형식이 올바르지 않습니다.');
    const counts = { members: 0, projects: 0, shoots: 0 };
    for (const m of payload.members || []) {
      const name = String(m.name || '').trim(); if (!name) continue;
      const department = String(m.department || m.dept || '미지정').trim() || '미지정';
      const id = memberIdFor(name);
      await saveDoc(organizedMemberPath({ name, department }), cleanMemberRecord(id, { ...m, name, department }));
      counts.members += 1;
    }
    for (const p of payload.projects || []) {
      const id = String(p.id || Date.now()); if (!p.name) continue;
      await saveDoc(`projects/${id}`, { ...p, id: undefined, name: p.name });
      counts.projects += 1;
    }
    for (const sh of payload.shoots || []) {
      const id = String(sh.id || crypto.randomUUID()); if (!sh.title || !sh.date) continue;
      await saveDoc(`shoots/${id}`, { ...sh, id: undefined });
      counts.shoots += 1;
    }
    return counts;
  },
  /** 지금 보고 있는 주의 촬영 일정과 개인 일정만 지운다. */
  async resetWeek() {
    const start = monday();
    const dates = DAYS.map((_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d; });
    const targets = dates.map(isoOf);
    const targetSet = new Set(targets);
    let removed = 0;
    for (const [id, sh] of Object.entries(shoots)) {
      if (targetSet.has(String(sh.date))) { await dropDoc(`shoots/${id}`); removed += 1; }
    }
    // 하루가 문서 하나다. 이번 주 7일치만 지운다.
    let cleared = 0;
    for (const member of Object.values(base)) {
      let touched = false;
      for (const iso of targets) {
        if (!allWeeks[weekKeyFromLabel(dayLabelOf(weekStartOf(iso)))]?.[memberDocId(member)]?.schedules?.[dayLabelOf(new Date(`${iso}T12:00:00`))]) continue;
        await dropDoc(`${personalPath(member)}/${iso}`); touched = true;
      }
      if (touched) cleared += 1;
    }
    return { shoots: removed, members: cleared };
  },
  /** 모든 스케줄러 데이터를 삭제한다. 되돌릴 수 없다. */
  async resetAll() {
    for (const member of Object.values(base)) {
      const docId = memberDocId(member);
      if (!docId) continue;
      await dropCollection(`members/${docId}/fixedClasses`);
      await dropCollection(`members/${docId}/availability`);
    }
    for (const path of ['shoots', 'projects', 'members', 'settings']) await dropCollection(path);
    return true;
  },
  async saveMember(record = {}) {
    const name = String(record.name || '').trim();
    const department = String(record.department || '미지정').trim() || '미지정';
    if (!name) throw new Error('이름을 입력하세요.');
    if (Object.values(base).some(m => m.name === name)) throw new Error('이미 등록된 이름입니다.');
    await saveDoc(organizedMemberPath({ name, department }), cleanMemberRecord(memberIdFor(name), { name, department, createdAt: Date.now() }));
    return { name, department };
  },
  async deleteMember(nameOrId) {
    const entry = Object.entries(base).find(([id, m]) => id === nameOrId || m.name === nameOrId);
    if (!entry) throw new Error('해당 인원을 찾지 못했습니다.');
    await deleteMemberEverywhere(entry[0], entry[1]);
  },
  setCompareMembers(ids) {
    state.filter = Array.isArray(ids) && ids.length && ids.length !== Object.keys(base).length ? new Set(ids) : null;
    render();
  },
  setRequiredMembers(ids) {
    state.required = new Set(Array.isArray(ids) ? ids : []);
    render();
  },
  async analyzeFile(file, projectId) {
    if (projectId) state.aiProjectId = projectId;
    await extractAiFile(file);
    await startAiAnalysis();
  },
  async prepareFile(file, projectId) {
    if (!file) throw new Error('대본 파일을 선택해 주세요.');
    if (projectId) state.aiProjectId = projectId;
    await extractAiFile(file);
    if (!aiState.extractedText) throw new Error('텍스트를 추출하지 못했습니다. 파일과 서버 연결을 확인해 주세요.');
  },
  async startAnalysis(projectId, options) {
    // 호출자가 프로젝트를 명시해야 한다. aiProjectId() 는 첫 프로젝트로 자동 대체하므로 여기서 쓰지 않는다.
    const target = String(projectId || '').trim();
    if (!target || !projects[target]) throw new Error('먼저 프로젝트를 선택해 주세요.');
    state.aiProjectId = target;
    state.aiProjectPicked = target;
    if (!aiState.extractedText) throw new Error('먼저 대본 파일을 업로드해 주세요.');
    if (Array.isArray(options)) aiState.options = Object.fromEntries(['scenes','cast','locations','schedule'].map((key,i) => [key, !!options[i]]));
    await startAiAnalysis();
    if (!aiState.job) throw new Error('분석을 시작하지 못했습니다. 서버 연결을 확인해 주세요.');
  },
  selectAnalysisProject(projectId) {
    if (!projectId || !projects[projectId]) { state.aiProjectPicked = ''; render(); return; }
    state.aiProjectId = projectId;
    state.aiProjectPicked = projectId;
    const saved = projects[projectId]?.aiAnalysis || {};
    aiState.file = null;
    aiState.extractedText = saved.script?.text || '';
    aiState.job = saved.job || saved.analysisJobs?.[saved.activeJobId] || null;
    aiState.mappings = { ...(saved.characterMappings || {}) };
    applyAutoCastMappings(aiState.job);
    state.aiSceneIndex = 0;
    if (['queued', 'running'].includes(aiState.job?.status)) pollAiJob(aiState.job.id);
    render();
  },
  async resetAnalysis(projectId) {
    if (projectId) state.aiProjectId = projectId;
    await resetAiProject();
  },
  async checkAi() {
    await checkAiHealth(true);
    return aiState.health;
  },
  /** 씬 목록을 넣으면 촬영안을 계산해 돌려준다. 저장은 하지 않는다.
   *  화면의 '무엇이든 넣어보기'와 검증에 쓴다. */
  previewSchedule(scenes = []) {
    return buildSceneSchedule(Array.isArray(scenes) ? scenes : []);
  },
  /** 기획자가 거는 조건을 바꾸고 다시 계산한다.
   *  pinned/split 은 씬 번호(S#3) 묶음 배열, excludeDates 는 'YYYY-MM-DD',
   *  priorityMembers 는 인원 ID 배열이다. */
  setPlanOptions(patch = {}) {
    const list = value => (Array.isArray(value) ? value : []);
    const groups = value => list(value).map(item => list(item).map(String).filter(Boolean)).filter(item => item.length > 1);
    const current = aiState.planOptions || {};
    aiState.planOptions = {
      pinned: patch.pinned === undefined ? list(current.pinned) : groups(patch.pinned),
      split: patch.split === undefined ? list(current.split) : groups(patch.split),
      excludeDates: patch.excludeDates === undefined ? list(current.excludeDates) : list(patch.excludeDates).map(String).filter(Boolean),
      priorityMembers: patch.priorityMembers === undefined ? list(current.priorityMembers) : list(patch.priorityMembers).map(String).filter(id => base[id]),
      // 이번 추천에서 뺄 씬. 계산에서만 빠지고 목록에서는 미배정으로 남는다.
      excludeScenes: patch.excludeScenes === undefined ? list(current.excludeScenes) : list(patch.excludeScenes).map(String).filter(Boolean),
      /* 하루 중 촬영 가능한 시간대. 방송국 촬영은 대부분 저녁이라 18시를 기본으로 둔다.
         이게 없으면 다들 비어 있는 오전 9시가 '가능'으로 나와 쓸 수 없는 답이 된다. */
      dayStart: patch.dayStart === undefined ? (Number(current.dayStart) || 18) : Math.min(22, Math.max(9, Number(patch.dayStart) || 18)),
      dayEnd: patch.dayEnd === undefined ? (Number(current.dayEnd) || 23) : Math.min(23, Math.max(10, Number(patch.dayEnd) || 23)),
      // 촬영 가능 기간. 비워두면 보고 있는 주만 본다.
      dateFrom: patch.dateFrom === undefined ? (current.dateFrom || '') : String(patch.dateFrom || ''),
      dateTo: patch.dateTo === undefined ? (current.dateTo || '') : String(patch.dateTo || ''),
      // 확정한 일정까지 다시 계산할지. 평소에는 건드리지 않는다.
      includeConfirmed: patch.includeConfirmed === undefined ? !!current.includeConfirmed : !!patch.includeConfirmed,
    };
    render();
    return aiState.planOptions;
  },
  getPlanOptions() { return aiState.planOptions || {}; },
  // 코파일럿: 날짜 하나를 주면 그날 찍을 수 있는 씬을 판정해 돌려준다.
  copilotForDate(iso) { return copilotForDate(String(iso || '')); },
};

/* 화면 UI 는 app.js 의 클릭 핸들러를 거치지 않고 이 브리지를 직접 부른다.
   그래서 동작 기록은 여기서 남겨야 빠짐없이 잡힌다. snapshot 은 매 렌더마다
   불리므로 제외한다. */
const LOG_LABELS = {
  saveShoot: '촬영 일정 저장', deleteShoot: '촬영 일정 삭제',
  saveProject: '프로젝트 저장', deleteProject: '프로젝트 삭제',
  saveMember: '인원 추가', deleteMember: '인원 삭제',
  addPersonalSchedule: '개인 일정 등록', deletePersonalScheduleDay: '개인 일정 삭제',
  saveFixedClass: '고정 수업 추가', deleteFixedClass: '고정 수업 삭제',
  saveSettings: '설정 저장', setMemberRole: '역할 변경',
  importData: '데이터 가져오기', resetWeek: '이번 주 일정 초기화', resetAll: '전체 초기화',
  startAnalysis: '대본 분석 시작', resetAnalysis: '분석 초기화',
  analyzeFile: '대본 업로드', prepareFile: '대본 준비',
};
for (const [name, label] of Object.entries(LOG_LABELS)) {
  const original = window.HNUBS_ENGINE[name];
  if (typeof original !== 'function') continue;
  window.HNUBS_ENGINE[name] = async function (...args) {
    try {
      const result = await original.apply(this, args);
      logEvent('act', label);
      return result;
    } catch (error) {
      logEvent('error', `${label} 실패 · ${error?.message || error}`);
      throw error;
    }
  };
}
