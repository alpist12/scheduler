/* 공유드라이브 목록 — 지정 폴더 안만 읽는다.
 *
 * 예전에는 바탕화면의 Node 서버(server.js)가 운영진 구글 계정 OAuth 토큰으로 읽었다.
 * 그 서버는 켜 둬야만 돌아서 배포본에서는 늘 샘플만 보였다. 서비스 계정으로 바꿔
 * 여기(Netlify)에서 읽는다. 부원은 로그인하지 않는다.
 *
 * 쓰기(업로드·수정·삭제)는 아직 여기 없다. 읽기만 한다.
 *
 * 준비물 — 둘 다 해야 동작한다:
 *  1) Netlify 환경변수 GOOGLE_DRIVE_SERVICE_ACCOUNT 에 서비스 계정 JSON
 *  2) 구글 드라이브에서 지정 폴더를 그 서비스 계정 이메일과 공유 (뷰어면 충분)
 * 하나라도 빠지면 아래 reason 에 무엇이 빠졌는지 담아 200 으로 돌려준다.
 * 화면은 그 응답을 보고 안내를 띄우고 샘플로 돌아간다.
 */
import { preflight, response } from './_shared.mjs';
import { googleToken, rateLimited, serviceAccountEmail } from './_google.mjs';

const ROOT_FOLDER_ID = '1Sb255-QJM--dC_1YGzJax-VlqpWtAxif';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const FIELDS = 'files(id,name,mimeType,size,modifiedTime,parents,starred,shared,trashed,description,webViewLink,webContentLink,thumbnailLink,appProperties,owners,videoMediaMetadata),nextPageToken';

const TEXT_EXT = ['txt', 'md', 'csv', 'json', 'srt', 'vtt'];
const KIND_BY_EXT = {
  mp4: 'video', mov: 'video', avi: 'video', mkv: 'video', webm: 'video',
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', heic: 'image',
  mp3: 'audio', wav: 'audio', aac: 'audio', flac: 'audio', m4a: 'audio',
  pdf: 'pdf', zip: 'zip', rar: 'zip', '7z': 'zip',
  psd: 'psd', ai: 'psd', aep: 'psd',
  txt: 'doc', md: 'doc', csv: 'doc', json: 'doc', docx: 'doc', xlsx: 'doc', hwp: 'doc',
};

const ext = name => String(name || '').split('.').pop().toLowerCase();

function detectKind(name, mimeType) {
  if (mimeType === 'application/vnd.google-apps.folder') return 'folder';
  if (mimeType?.startsWith('video/')) return 'video';
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType?.startsWith('audio/')) return 'audio';
  return KIND_BY_EXT[ext(name)] || 'file';
}

function dateStr(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function durationOf(file) {
  const ms = Number(file.videoMediaMetadata?.durationMillis || 0);
  if (!ms) return file.appProperties?.dur;
  const total = Math.round(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function mapFile(f) {
  const rawParentId = f.parents?.[0] || null;
  const props = f.appProperties || {};
  return {
    id: f.id,
    name: f.name,
    kind: detectKind(f.name, f.mimeType),
    mimeType: f.mimeType,
    parent: rawParentId === ROOT_FOLDER_ID ? 'root' : (rawParentId || 'external'),
    rawParentId,
    size: Number((Number(f.size || 0) / (1024 * 1024)).toFixed(2)),
    date: dateStr(f.modifiedTime),
    by: props.uploadedBy || f.owners?.[0]?.displayName || '관리자',   // 이름만, owners 원본은 내보내지 않는다
    dur: durationOf(f),
    starred: Boolean(f.starred),
    shared: Boolean(f.shared || props.shared === 'true'),
    trashed: Boolean(f.trashed),
    description: f.description || '',
    webViewLink: f.webViewLink || '',
    webContentLink: '',   // 내려받기 주소는 내보내지 않는다. 필요하면 webViewLink 로 연다.
    thumbnailLink: f.thumbnailLink || '',
    editable: TEXT_EXT.includes(ext(f.name)) || f.mimeType === 'application/vnd.google-apps.document',
    source: 'google',
  };
}

/** 지정 폴더에서 아래로 훑는다. 폴더를 한 겹씩 넓혀 가며 그 안의 것만 받는다.
 *  드라이브 전체를 받아 와서 걸러 내면 공유된 남의 파일까지 딸려 온다. */
async function listSubtree(token) {
  const headers = { authorization: `Bearer ${token}` };
  const out = [];
  let frontier = [ROOT_FOLDER_ID];
  const seen = new Set(frontier);

  // 폴더가 깊어도 멈추게 한다. 20겹이면 실제 운영에서 충분하다.
  for (let depth = 0; depth < 20 && frontier.length; depth += 1) {
    const next = [];
    for (const parent of frontier) {
      let pageToken = '';
      do {
        const params = new URLSearchParams({
          q: `'${parent}' in parents and mimeType != 'application/vnd.google-apps.shortcut'`,
          fields: FIELDS,
          pageSize: '1000',
          orderBy: 'folder,modifiedTime desc',
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
        });
        if (pageToken) params.set('pageToken', pageToken);

        const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers });
        if (!res.ok) {
          const body = await res.text();
          const err = new Error(`드라이브 목록을 받지 못했습니다 (${res.status}): ${body.slice(0, 200)}`);
          err.status = res.status;
          throw err;
        }
        const body = await res.json();
        for (const file of body.files || []) {
          out.push(file);
          if (file.mimeType === 'application/vnd.google-apps.folder' && !seen.has(file.id)) {
            seen.add(file.id);
            next.push(file.id);
          }
        }
        pageToken = body.nextPageToken || '';
      } while (pageToken);
    }
    frontier = next;
  }
  return out;
}

export const handler = async event => {
  const pre = preflight(event); if (pre) return pre;

  // 목록 전체를 반복해서 긁어 가지 못하게 막는다.
  const wait = rateLimited(event, 'drive-files', 30, 60_000);
  if (wait) {
    const base = response(429, { error: `요청이 너무 잦습니다. ${wait}초 뒤에 다시 시도해 주세요.` }, event);
    return { ...base, headers: { ...base.headers, 'retry-after': String(wait) } };
  }

  const email = (() => { try { return serviceAccountEmail(); } catch { return ''; } })();

  let token;
  try {
    token = await googleToken(SCOPE);
  } catch (error) {
    // 자세한 내용은 서버 로그에만 남긴다. 키 경로나 계정 정보가 화면으로 새면 안 된다.
    console.error('[drive-files] 토큰 발급 실패:', error.message);
    return response(200, { mode: 'unconfigured', reason: 'token', items: [] }, event);
  }
  if (!token) {
    return response(200, { mode: 'unconfigured', reason: 'no-service-account', items: [] }, event);
  }

  try {
    const files = await listSubtree(token);
    const items = files.map(mapFile);
    const usedBytes = files.reduce((sum, f) => sum + Number(f.size || 0), 0);

    return response(200, {
      mode: 'google',
      rootFolderId: ROOT_FOLDER_ID,
      storageQuota: {
        // 서비스 계정은 남의 드라이브 총 용량을 못 본다. 쓴 만큼만 실제 값이고
        // 총 용량은 화면 설정값(기본 200GB)을 그대로 쓴다.
        limitGb: null,
        usageGb: Number((usedBytes / (1024 ** 3)).toFixed(2)),
        usageInDriveGb: Number((usedBytes / (1024 ** 3)).toFixed(2)),
        usageInTrashGb: 0,
      },
      items,
    }, event);
  } catch (error) {
    // 404/403 은 거의 폴더를 서비스 계정과 공유하지 않은 경우다.
    const shareIssue = error.status === 404 || error.status === 403;
    console.error('[drive-files] 목록 실패:', error.status || '', error.message);
    return response(200, {
      mode: 'unconfigured',
      reason: shareIssue ? 'not-shared' : 'error',
      items: [],
    }, event);
  }
};
