/* API 서버 주소. 화면(정적 파일)과 API 서버가 갈라질 때 여기 한 줄만 고친다.
 *
 *   ''                              같은 출처에서 /api/* 를 받을 때 (한 서버가 둘 다 할 때)
 *   'https://<이름>.workers.dev'    GitHub Pages 처럼 화면만 정적으로 올릴 때
 *
 * 화면 코드(index.html)와 엔진(app.js)이 서로 다른 프레임에서 돌기 때문에
 * 양쪽이 같은 값을 보도록 이 파일 하나만 읽게 해 두었다. 두 군데에 적어 두면
 * 배포할 때 한쪽만 고치고 끝나기 쉽다.
 *
 * NVIDIA 키나 관리자 비밀번호는 절대 여기 두지 않는다. 이 파일은 브라우저로
 * 그대로 내려가므로 누구나 열어 볼 수 있다. 비밀값은 API 서버에만 둔다.
 */
/* 정식 사이트는 GitHub Pages 이고, /api/* 만 Netlify 가 맡는다.
   로컬(빈 문자열)에서는 같은 출처에서 찾으므로 AI 기능만 쉰다. */
window.HNUBS_API = location.hostname.endsWith('github.io') ? 'https://hnubs1212.netlify.app' : '';
