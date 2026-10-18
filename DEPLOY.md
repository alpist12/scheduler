# 배포

화면과 API 서버가 **서로 다른 곳**에 올라간다. 둘을 잇는 설정이 `api-config.js` 한 줄이다.

```
GitHub Pages            Cloudflare Workers              Firebase
화면·정적 파일     →    /api/* (NVIDIA 키, 관리자 비번)  →  Firestore (일정 데이터)
무료                    무료 10만 요청/일                  기존 그대로
```

## 왜 이렇게 나눴나

GitHub Pages 는 정적 파일만 내보내고 **서버 코드를 실행하지 않는다.** 그래서 NVIDIA 키를
JS 파일이든 Firestore 든 어디에 넣어도 결국 브라우저까지 내려가고, 내려간 값은 누구나
개발자 도구로 꺼낼 수 있다. 관리자 비밀번호도 같다 — 화면에서 비교하면 뚫린다.

그래서 **비밀값이 필요한 것만** Workers 에 남기고 나머지는 전부 정적으로 보낸다.
일정·인원·촬영·자동배치는 Firebase SDK 로 Firestore 에 직접 붙으므로 서버가 필요 없다.

## 1. API 서버 (Cloudflare Workers)

```bash
npm i -D wrangler
npx wrangler login

# 비밀값은 레포에 적지 않는다. Cloudflare 에만 저장된다.
npx wrangler secret put NVIDIA_API_KEY
npx wrangler secret put SCHEDULER_ADMIN_PASSWORD

npx wrangler deploy
```

배포하면 `https://hnubs-scheduler-api.<계정>.workers.dev` 주소가 나온다.

확인:

```bash
curl https://hnubs-scheduler-api.<계정>.workers.dev/api/health
```

## 2. 화면 (GitHub Pages)

1. GitHub 에 레포를 만들고 이 폴더를 푸시한다.
2. Settings → Pages → Source 를 **Deploy from a branch**, 브랜치 `main` / `(root)` 로.
3. `https://<계정>.github.io/<레포>/` 가 열린다.

> **Pages 는 공개 레포에서만 무료다.** 비공개로 두려면 GitHub Pro 가 필요하다.
> 소스가 공개돼도 비밀값은 Workers 에 있으므로 노출되지 않는다. 다만 일정 데이터는
> Firestore 규칙이 지키므로, 규칙을 느슨하게 두면 안 된다 (아래 참고).

## 3. 둘을 잇기

`api-config.js` 의 한 줄을 1번에서 받은 주소로 바꾼다.

```js
window.HNUBS_API = 'https://hnubs-scheduler-api.<계정>.workers.dev';
```

그리고 `wrangler.toml` 의 `ALLOWED_ORIGINS` 를 Pages 주소로 바꾸고 다시 배포한다.
이게 어긋나면 브라우저가 응답을 버려서 **AI 기능만 조용히 안 된다** (화면은 멀쩡하다).

```toml
ALLOWED_ORIGINS = "https://<계정>.github.io"
```

확인: 사이트를 열고 개발자 도구 → Network 에서 `/api/health` 가 200 이면 연결된 것이다.

## 로컬에서 돌릴 때

`api-config.js` 를 `''` 로 두면 같은 출처에서 `/api/*` 를 찾는다.

```bash
npx wrangler dev      # http://localhost:8787 — 화면과 API 를 한 번에
```

점검 게이트는 `/api` 가 없으면 사이트를 잠그지만, `localhost` 는 예외로 열어 둔다.

## Firestore 규칙 — 확인 필요

`firestore.rules` 에 적힌 만료일이 **이미 지났다**. 이 파일을 그대로 배포하면
모든 읽기·쓰기가 차단된다. 실제 콘솔에 배포된 규칙과도 다르다.

콘솔(Firebase → Firestore → 규칙)의 원문을 이 파일에 복사해 맞춘 뒤에 배포할 것.
맞추기 전에는 `firebase deploy --only firestore:rules` 를 실행하지 않는다.
