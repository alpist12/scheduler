# NVIDIA NIM 대본 분석 실행

AI 대본 분석은 브라우저가 아니라 `server.py`가 NVIDIA API 키를 보관하고 호출합니다. 키는 Firebase나 프런트엔드 코드에 넣지 않습니다.

## Windows PowerShell

```powershell
cd "C:\Users\alpis\Downloads\대학신문방송국\scheduler"
python -m pip install -r requirements.txt
$env:AI_PROVIDER = "NVIDIA"
$env:NVIDIA_API_KEY = "발급받은_NVIDIA_API_키"
$env:NVIDIA_MODEL = "openai/gpt-oss-20b"
$env:NVIDIA_FALLBACK_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b"
python server.py
```

브라우저에서 `http://127.0.0.1:4173/`을 열고 `AI 대본 분석` 탭을 사용합니다.

## 데이터 위치

분석 결과는 선택한 프로젝트 아래에 저장됩니다.

```text
scheduler/프로젝트/{projectId}/aiAnalysis/
  provider
  model
  script
  scenes
  characters
  characterMappings
  analysisJobs
  activeJobId
  scheduleCandidates
  confirmedSchedule
```

원본 파일 자체는 Firebase에 저장하지 않습니다. 추출 텍스트가 100만 자 이하일 때만 프로젝트 분석 데이터에 저장하며, 그보다 크면 파일명과 글자 수만 남깁니다.

## Netlify 배포

이 프로젝트에는 `api` 아래에 배포용 API 함수가 포함되어 있습니다. 단순 정적 폴더 업로드 대신 Git 저장소 연결 또는 Netlify CLI 배포를 사용해야 함수도 함께 배포됩니다.

Netlify 사이트에서 다음 순서로 설정합니다.

1. `Project configuration` → `Environment variables`로 이동합니다.
2. `NVIDIA_API_KEY`를 추가하고 값에는 발급받은 키를 넣습니다. 비밀 키를 `app.js`, Firebase, `netlify.toml`에는 넣지 않습니다.
3. 필요하면 `NVIDIA_MODEL=openai/gpt-oss-20b`도 추가합니다.
   모델 종료에 대비한 예비 모델은 `NVIDIA_FALLBACK_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b`로 설정할 수 있습니다.
4. 환경변수 변경 후 새 배포를 실행합니다.
5. 배포된 사이트의 `/api/health`에서 `configured: true`, `runtime: Netlify Functions`인지 확인합니다.

환경변수가 없으면 AI 화면에 설정 필요 상태가 표시됩니다. NVIDIA가 일시적으로 429 또는 5xx를 반환하면 함수가 최대 3회 자동 재시도합니다.
