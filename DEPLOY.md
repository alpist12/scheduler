# 배포

두 곳에 올라간다. **둘 다 올려야** 전부 동작한다.

```
GitHub Pages                  Cloudflare Workers              Firebase
화면·정적 파일          →     /api/* (NVIDIA 키, 관리자 비번)  →  Firestore (일정)
무료                           무료 10만 요청/일                기존 그대로
alpist12.github.io/scheduler   hnubs-scheduler-api.workers.dev  기존 그대로
```

## 왜 서버가 아직 필요한가

GitHub Pages 는 정적 파일만 내보내고 **서버 코드를 실행하지 않는다.** NVIDIA 키를
JS 파일이든 Firestore 든 어디에 넣어도 브라우저까지 내려가고, 내려간 값은 누구나
개발자 도구로 꺼낼 수 있다. 관리자 비밀번호도 같다.

그래서 **비밀값이 필요한 것만** Netlify 에 남는다:

| 경로 | 왜 서버인가 |
|---|---|
| `/api/chat` | NVIDIA 키 |
| `/api/analysis/*` | NVIDIA 키 |
| `/api/maintenance` | 관리자 비밀번호 검증 |

나머지는 전부 브라우저에서 한다. 일정·인원·촬영·자동배치는 Firebase SDK 로
Firestore 에 직접 붙고, 대본 추출(PDF·DOCX)도 브라우저에서 푼다.

## 1. 화면 (GitHub Pages)

`main` 에 푸시하면 `.github/workflows/deploy.yml` 이 `npm run build` 를 돌리고
**`dist/client`** 를 올린다. 레포 루트가 아니라 빌드 결과를 올린다는 점이 중요하다.

> 정적 파일을 새로 추가했다면 `tools/build-sites.mjs` 의 복사 목록에도 넣어야 한다.
> 빠뜨리면 로컬에서는 되는데 배포본에서만 404 가 난다.

## 2. API (Cloudflare Workers)

**화면만 올리고 끝내면 안 된다.** API 는 따로 배포해야 반영된다.

```bash
npx wrangler login
npx wrangler secret put NVIDIA_API_KEY            # 값은 묻는 대로 붙여넣는다
npx wrangler secret put SCHEDULER_ADMIN_PASSWORD
npm run api:deploy
```

비밀값은 레포에 들어가지 않고 Cloudflare 에만 저장된다. 모델·엔드포인트 이름처럼
비밀이 아닌 값은 `wrangler.toml` 의 `[vars]` 에 있다.

배포본이 최신인지 확인:

```bash
curl -s https://hnubs-scheduler-api.<계정>.workers.dev/api/health
```

`runtime` 이 `Sites Worker`, `configured` 가 `true` 면 키까지 들어간 것이다.

> **화면과 API 를 따로 배포한다는 걸 잊기 쉽다.** 실제로 한 번 이것 때문에 깨졌다 —
> CORS 헤더를 코드에 넣고 서버를 재배포하지 않아, 화면은 멀쩡한데 AI 기능만
> 죽어 있었다.

### 무료 플랜에 맞춰 둔 것들

무료 Workers 는 요청당 CPU 10ms, 백그라운드 30초, 외부 호출 50회가 한도다.
이 한도를 넘지 않도록 두 가지를 구조로 해결해 두었다. 되돌리면 다시 걸린다.

- **대본 추출은 브라우저에서 한다.** 서버에서 PDF 를 풀면 CPU 10ms 를 바로 넘는다.
- **분석은 묶음 하나당 요청 하나다.** 서버가 전부 백그라운드로 돌면 30초에 잘려
  작업이 '분석 중'인 채로 남는다.

## 3. 둘을 잇는 설정

`api-config.js` 한 줄이 화면이 어느 API 를 부를지 정한다.

```js
window.HNUBS_API = location.hostname.endsWith('github.io') ? 'https://hnubs.netlify.app' : '';
```

로컬에서는 빈 문자열 → 같은 출처. GitHub Pages 에서는 Netlify 절대주소.
서버를 옮기면 **이 줄만** 고치면 된다.

출처가 다르므로 **CORS 가 필수**다. `api/_shared.mjs` 의 `response()` 가 헤더를
붙인다. 이게 빠지면 브라우저가 응답을 버려서 AI 기능만 조용히 죽는다.

CSP 도 마찬가지다. `netlify.toml` 의 `script-src` 에 `cdnjs.cloudflare.com` 이 있어야
대본 추출(pdf.js, mammoth)이 로드된다.

## 로컬에서

```bash
npm run build
cd dist/client && python -m http.server 4321
```

`api-config.js` 가 빈 문자열이 되어 같은 출처에서 `/api/*` 를 찾는다. 정적 서버에는
API 가 없으므로 AI 기능은 안 되지만, 일정 관리는 Firestore 에 직접 붙어 동작한다.
점검 게이트는 `/api` 가 없으면 사이트를 잠그지만 `localhost` 는 예외로 열어 둔다.

## Firestore 규칙

`firestore.rules` 는 현재 날짜 제한만 걸린 전면 허용이다.

```
allow read, write: if request.time < timestamp.date(2027, 12, 31);
```

인증을 도입하기 전까지는 좁힐 수 없는 구조다(앱이 익명 쓰기에 의존). 레포가
공개이므로, 데이터를 지키는 건 사실상 문서 ID 가 UUID 라는 점뿐이다.
