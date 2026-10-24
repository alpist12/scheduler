// 화면과 API 서버가 갈라져도 동작하는지. 한 군데라도 풀리면 GitHub Pages 에서 AI 기능이 죽는다.
import assert from 'node:assert';
import fs from 'node:fs';

// ── 1) API 주소는 api-config.js 한 곳에서만 정한다
{
  const cfg = fs.readFileSync('api-config.js', 'utf8');
  assert(/window\.HNUBS_API\s*=/.test(cfg), 'api-config.js 가 주소를 정의하지 않는다');
  assert(!/NVIDIA|API_KEY|PASSWORD|비밀번호/i.test(cfg.replace(/\/\*[\s\S]*?\*\//g, '')),
    'api-config.js 는 브라우저로 내려간다. 비밀값을 두면 안 된다');

  for (const f of ['index.html', 'index.integrated.html']) {
    assert(fs.readFileSync(f, 'utf8').includes('api-config.js'), `${f} 가 설정을 안 읽는다`);
  }
  for (const f of ['app.js', 'index.html']) {
    assert(/window\.HNUBS_API/.test(fs.readFileSync(f, 'utf8')), `${f} 가 설정을 안 쓴다`);
  }
  // 예전처럼 주소를 직접 계산하는 곳이 남아 있으면 한쪽만 다른 서버를 보게 된다
  const html = fs.readFileSync('index.html', 'utf8');
  assert(!/\$\{location\.pathname\.startsWith\('\/scheduler'\) \? '\/scheduler' : ''\}\/api/.test(html),
    'index.html 에 주소를 직접 만드는 곳이 남아 있다');
}

// ── 3) 비밀값이 레포에 들어오지 않았는지
{
  for (const f of ['wrangler.toml', 'api-config.js']) {
    const t = fs.readFileSync(f, 'utf8');
    assert(!/nvapi-|AIza[0-9A-Za-z_-]{30,}/.test(t.replace(/AIzaSyDXmeiQpRSZshFA1_BgZ2z_8AKLy6_Nc8M/g, '')),
      `${f} 에 비밀키로 보이는 값이 있다`);
  }
}
// ── 4) 빌드 산출물(Pages 가 실제로 올리는 것)에 설정이 들어갔는지
{
  const built = 'dist/client/';
  for (const f of ['api-config.js', 'index.html', 'index.integrated.html']) {
    assert(fs.existsSync(built + f), `빌드 결과에 ${f} 가 없다`);
  }
  for (const f of ['index.html', 'index.integrated.html']) {
    assert(fs.readFileSync(built + f, 'utf8').includes('api-config.js'),
      `빌드된 ${f} 가 설정을 안 읽는다 — Pages 에서 AI 기능이 죽는다`);
  }
  assert(fs.readFileSync('tools/build-sites.mjs', 'utf8').includes("'api-config.js'"),
    '빌드 목록에 api-config.js 가 빠졌다');

  // 호스트별로 어느 주소를 고르는지
  const cfg = fs.readFileSync('api-config.js', 'utf8');
  const pick = host => {
    const win = {}, location = { hostname: host };
    new Function('window', 'location', cfg)(win, location);
    return win.HNUBS_API;
  };
  assert.equal(pick('127.0.0.1'), '', '로컬에서 외부 주소를 부른다');
  assert.equal(pick('localhost'), '', '로컬에서 외부 주소를 부른다');
  assert(/^https:\/\//.test(pick('alpist12.github.io')),
    'GitHub Pages 에서 상대경로를 부른다 — 같은 출처에 API 가 없어 404 가 난다');
}
// ── 5) 대본 추출은 브라우저에서 한다 (무료 함수의 CPU 한도를 넘기지 않으려고)
{
  const client = fs.readFileSync('extract-client.js', 'utf8');
  assert(/export async function extractText/.test(client), 'extractText 가 없다');
  assert(/pdf\.js|pdf\.min\.mjs/.test(client), 'PDF 처리가 없다');
  assert(/mammoth/.test(client), 'DOCX 처리가 없다');

  // 서버 쪽 추출 경로가 되살아나면 20MB 업로드와 CPU 과금이 돌아온다
  assert(!fs.existsSync('api/extract.mjs'), '서버 추출 함수가 남아 있다');
  const worker = fs.readFileSync('sites/worker.mjs', 'utf8');
  assert(!/\/api\/extract/.test(worker), 'worker 에 extract 라우트가 남아 있다');
  const app = fs.readFileSync('app.js', 'utf8');
  assert(!/\/api\/extract/.test(app), '앱이 아직 서버 추출을 부른다');
  assert(!/fileToBase64/.test(app), '안 쓰는 base64 변환이 남아 있다');
  assert(/extract-client\.js/.test(app), '앱이 브라우저 추출기를 안 쓴다');

  // 무거운 파서가 서버 의존성으로 돌아오지 않았는지
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  for (const dep of ['mammoth', 'pdf-parse']) {
    assert(!(dep in (pkg.dependencies || {})), `${dep} 가 서버 의존성에 남아 있다`);
  }
  assert(fs.readFileSync('tools/build-sites.mjs', 'utf8').includes("'extract-client.js'"),
    '빌드 목록에 extract-client.js 가 빠졌다');
}
// ── 6) 화면과 API 가 다른 출처다. CORS 와 CSP 가 빠지면 AI 기능만 조용히 죽는다.
{
  /* CORS 는 핸들러가 붙인다. Netlify 는 worker 를 거치지 않고 핸들러를 바로
     부르므로, 바깥에만 맡기면 그 환경에서 아무도 안 붙인다. */
  const shared = fs.readFileSync('api/_shared.mjs', 'utf8');
  assert(/access-control-allow-origin/.test(shared), '핸들러가 CORS 를 안 붙인다');
  const corsBlock = shared.slice(shared.indexOf('export const corsFor'), shared.indexOf('export const preflight'));
  assert(!corsBlock.includes("'*'"), 'CORS 를 모든 출처에 열어 두었다 — 남의 호출도 이쪽 NVIDIA 요금이 된다');

  const worker = fs.readFileSync('sites/worker.mjs', 'utf8');
  assert(!/corsHeaders|allowOrigin/.test(worker),
    'worker 도 CORS 를 붙인다 — 두 곳이 서로 덮어쓴다');
  assert(/if \(method === 'OPTIONS'\) method = 'POST';/.test(worker),
    'preflight 가 라우트를 못 찾아 404 가 된다');
  assert(/status === 204 \|\| status === 304 \? null/.test(worker),
    '204 에 본문을 실어 Response 생성이 터진다');

  // 허용 목록 판정을 실제로 돌려 본다
  const m = [shared.slice(shared.indexOf('export const allowedOrigins'), shared.indexOf('export const preflight'))];
  assert(m[0].includes('corsFor'), 'corsFor 를 못 찾았다');
  const corsFor = new Function('process', `${m[0].replace(/export /g, '')}
return corsFor;`)(
    { env: { ALLOWED_ORIGINS: 'https://alpist12.github.io, https://a.test/' } });
  assert.equal(corsFor('https://alpist12.github.io')['access-control-allow-origin'],
    'https://alpist12.github.io');
  assert.equal(corsFor('https://a.test')['access-control-allow-origin'], 'https://a.test',
    '끝 슬래시 차이로 막힌다');
  assert.deepEqual(corsFor('https://evil.test'), {}, '목록에 없는 출처를 통과시킨다');
  assert.deepEqual(corsFor(''), {}, '출처 없는 요청에 헤더를 붙인다');

  // 모든 핸들러가 preflight 를 처리하는지
  for (const name of ['health', 'chat', 'maintenance', 'analysis-start', 'analysis-retry', 'analysis-job', 'chat-job']) {
    const h = fs.readFileSync(`api/${name}.mjs`, 'utf8');
    assert(/preflight\(event\)/.test(h), `${name}: preflight 처리가 없다 — 브라우저가 본 요청을 안 보낸다`);
  }

  const toml = fs.readFileSync('netlify.toml', 'utf8');
  assert(/directory = "api"/.test(toml), 'Netlify 가 함수 폴더를 못 찾는다');
  assert(!/api\/extract/.test(toml), '없앤 extract 라우트가 남아 있다');

  const csp = toml.match(/Content-Security-Policy = "([^"]+)"/)?.[1] || '';
  const scriptSrc = csp.match(/script-src ([^;]+)/)?.[1] || '';
  assert(/cdnjs\.cloudflare\.com/.test(scriptSrc),
    'CSP script-src 에 cdnjs 가 없다 — 대본 추출(pdf.js)이 막힌다');
  assert(/worker-src/.test(csp), 'CSP 에 worker-src 가 없다 — pdf.js 워커가 막힌다');

  // 모든 /api 경로에 리다이렉트가 있는지 (앱이 부르는 것과 맞는지)
  for (const p of ['/api/health', '/api/chat', '/api/maintenance', '/api/analysis/jobs']) {
    assert(toml.includes(`from = "${p}"`), `netlify.toml 에 ${p} 라우트가 없다`);
  }
}
// ── 정식 사이트는 GitHub Pages, Netlify 는 API 전용
{
  const toml = fs.readFileSync('netlify.toml', 'utf8');
  assert(!/publish = "\."/.test(toml),
    'Netlify 가 레포 루트를 올린다 — 소스가 그대로 열리고 빌드 분도 더 먹는다');
  assert(/publish = "netlify-public"/.test(toml), '올릴 폴더가 안내 페이지가 아니다');
  assert(fs.existsSync('netlify-public/index.html'), '안내 페이지가 없다 — 배포가 실패한다');

  // 화면이 가리키는 주소와 실제 API 호스트가 같아야 한다
  const cfg = fs.readFileSync('api-config.js', 'utf8');
  // 주석의 예시 URL 이 아니라 실제로 대입하는 값만 본다
  const host = cfg.match(/HNUBS_API\s*=[^;]*?'(https:\/\/[^']+)'/)?.[1];
  assert(host, 'api-config 에 API 주소가 없다');
  assert(/netlify\.app$|workers\.dev$/.test(host), `API 주소가 이상하다: ${host}`);
  assert(fs.readFileSync('DEPLOY.md', 'utf8').includes(host.replace('https://', '')),
    'DEPLOY.md 가 다른 주소를 안내한다 — 배포 때 엇갈린다');
}
console.log('api split OK');
