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

// ── 2) 다른 출처에서 부르려면 CORS 가 있어야 한다
{
  const w = fs.readFileSync('sites/worker.mjs', 'utf8');
  assert(/access-control-allow-origin/.test(w), 'CORS 헤더가 없다');
  assert(/OPTIONS/.test(w), 'preflight(OPTIONS) 처리가 없다');
  assert(/ALLOWED_ORIGINS/.test(w), '허용 출처 설정이 없다');
  assert(!/access-control-allow-origin['"]?\s*:\s*['"]\*/.test(w),
    '관리자 비밀번호를 받는 API 를 모든 출처에 열어 두었다');

  // 허용 목록 판정만 떼어 와 확인
  const m = w.match(/function allowOrigin\(request\) \{[\s\S]*?\n\}/);
  assert(m, 'allowOrigin 없음');
  const allowOrigin = new Function('process', `${m[0]}\nreturn allowOrigin;`)(
    { env: { ALLOWED_ORIGINS: 'https://alpist07.github.io, https://example.test/' } });
  const req = origin => ({ headers: { get: () => origin } });

  assert.equal(allowOrigin(req('https://alpist07.github.io')), 'https://alpist07.github.io');
  assert.equal(allowOrigin(req('https://example.test')), 'https://example.test', '끝 슬래시 차이로 막힌다');
  assert.equal(allowOrigin(req('https://evil.test')), '', '목록에 없는 출처를 통과시킨다');
  assert.equal(allowOrigin(req('')), '', '출처 없는 요청에 헤더를 붙인다');
}

// ── 3) 비밀값이 레포에 들어오지 않았는지
{
  for (const f of ['wrangler.toml', 'api-config.js']) {
    const t = fs.readFileSync(f, 'utf8');
    assert(!/nvapi-|AIza[0-9A-Za-z_-]{30,}/.test(t.replace(/AIzaSyDXmeiQpRSZshFA1_BgZ2z_8AKLy6_Nc8M/g, '')),
      `${f} 에 비밀키로 보이는 값이 있다`);
  }
}
console.log('api split OK');
