/* 구글 API 토큰 — 서비스 계정으로 받는다.
 *
 * _shared.mjs 의 serviceToken() 은 Firestore(datastore) 전용 scope 로 굳어 있고
 * 토큰도 하나만 캐시한다. 드라이브는 scope 가 달라서 같이 쓰면 서로 덮는다.
 * 여기서는 scope 별로 따로 캐시한다.
 *
 * 환경변수는 Netlify 에만 둔다. 저장소에 올리지 않는다.
 *   GOOGLE_DRIVE_SERVICE_ACCOUNT  드라이브용 서비스 계정 JSON (없으면 FIREBASE_SERVICE_ACCOUNT)
 */

const b64url = input => Buffer.from(input).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const cache = new Map();   // scope -> { token, expires }

function account() {
  const raw = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error('client_email 또는 private_key 가 없습니다.');
    }
    return parsed;
  } catch (error) {
    throw new Error(`서비스 계정 JSON 을 읽지 못했습니다: ${error.message}`);
  }
}

export const serviceAccountEmail = () => account()?.client_email || '';

export async function googleToken(scope) {
  const sa = account();
  if (!sa) return null;

  const hit = cache.get(scope);
  if (hit && hit.expires > Date.now() + 60_000) return hit.token;

  const { createSign } = await import('node:crypto');
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claim))}`;

  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  // 환경변수에 넣을 때 줄바꿈이 \n 두 글자로 들어가는 일이 잦다. 진짜 줄바꿈으로 되돌린다.
  const pem = sa.private_key.includes('\\n') ? sa.private_key.replace(/\\n/g, '\n') : sa.private_key;
  const jwt = `${unsigned}.${b64url(signer.sign(pem))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!res.ok) {
    throw new Error(`서비스 계정 토큰 발급 실패 (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const body = await res.json();
  cache.set(scope, { token: body.access_token, expires: Date.now() + (body.expires_in || 3600) * 1000 });
  return body.access_token;
}

/* 간단한 호출 횟수 제한.
 * 이 저장소의 _shared.mjs 에는 아직 rateLimited 가 없다. 거긴 다른 작업이 올라가 있어서
 * 건드리지 않고, 쓰는 쪽에서 들고 있는다.
 *
 * 함수 인스턴스 하나의 메모리에만 쌓인다. 인스턴스가 여러 개면 그만큼 느슨해진다.
 * 긁어 가기를 늦추는 용도지, 정확한 방어선은 아니다.
 */
const callLog = new Map();
const CALL_LOG_MAX = 5000;

// Netlify 엣지가 넣는 헤더만 믿는다. 클라이언트가 보낸 값은 엣지가 덮어쓴다.
const clientIp = event => String(event?.headers?.['x-nf-client-connection-ip'] || 'unknown').split(',')[0].trim();

export function rateLimited(event, name, max, windowMs) {
  const now = Date.now();
  const key = `${name}:${clientIp(event)}`;
  const times = (callLog.get(key) || []).filter(t => now - t < windowMs);
  if (times.length >= max) return Math.ceil((windowMs - (now - times[0])) / 1000);
  times.push(now);
  callLog.set(key, times);
  if (callLog.size > CALL_LOG_MAX) {
    for (const [k, v] of callLog) {
      if (!v.length || now - v[v.length - 1] > windowMs) callLog.delete(k);
      if (callLog.size <= CALL_LOG_MAX) break;
    }
  }
  return 0;
}
