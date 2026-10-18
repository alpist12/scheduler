/* 대본 파일에서 글자를 뽑는다. 브라우저에서 한다.
 *
 * 예전에는 파일을 통째로(최대 20MB) 서버에 올려 거기서 파싱했다. 그래서
 *   - 업로드가 느리고,
 *   - 서버가 PDF 를 푸느라 CPU 를 오래 쓰고(무료 함수 한도에 바로 걸린다),
 *   - 대본 원문이 네트워크를 한 번 더 건너갔다.
 * 어차피 파일은 이미 브라우저에 있다. 여기서 풀면 셋 다 사라진다.
 *
 * 라이브러리는 쓸 때 한 번만 받는다. 대본을 안 올리는 사람은 받지도 않는다.
 */
const CDN = {
  pdf: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.min.mjs',
  pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.worker.min.mjs',
  mammoth: 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js',
};

let pdfLib = null;
async function loadPdf() {
  if (pdfLib) return pdfLib;
  pdfLib = await import(CDN.pdf);
  pdfLib.GlobalWorkerOptions.workerSrc = CDN.pdfWorker;
  return pdfLib;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = src;
    tag.onload = resolve;
    tag.onerror = () => reject(new Error('라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.'));
    document.head.append(tag);
  });
}

/** PDF 한 장씩 글자를 모은다. onProgress(지금, 전체) 로 진행을 알린다. */
async function fromPdf(buffer, onProgress) {
  const pdfjs = await loadPdf();
  const doc = await pdfjs.getDocument({ data: buffer }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    /* 같은 줄에 있던 조각을 줄 단위로 되돌린다. 이어 붙이기만 하면
       씬 제목과 지문이 한 줄로 뭉쳐 장면 구분이 깨진다. */
    let line = '', lastY = null;
    const out = [];
    for (const item of content.items) {
      const y = Math.round((item.transform?.[5] ?? 0) * 10) / 10;
      if (lastY !== null && y !== lastY) { out.push(line); line = ''; }
      line += item.str;
      if (item.hasEOL) { out.push(line); line = ''; }
      lastY = y;
    }
    if (line) out.push(line);
    pages.push(out.join('\n'));
    onProgress?.(n, doc.numPages);
  }
  return { text: pages.join('\n\n'), pages: doc.numPages };
}

async function fromDocx(buffer) {
  if (!window.mammoth) await loadScript(CDN.mammoth);
  const { value } = await window.mammoth.extractRawText({ arrayBuffer: buffer });
  return { text: value, pages: 0 };
}

/** 파일 → { text, characters, pages }. 서버를 거치지 않는다. */
export async function extractText(file, onProgress) {
  const ext = String(file.name || '').toLowerCase().split('.').pop();
  let result;
  if (ext === 'txt') {
    result = { text: (await file.text()).replace(/^﻿/, ''), pages: 0 };
  } else if (ext === 'pdf') {
    result = await fromPdf(await file.arrayBuffer(), onProgress);
  } else if (ext === 'docx') {
    result = await fromDocx(await file.arrayBuffer());
  } else {
    throw new Error('PDF, DOCX, TXT 파일만 지원합니다.');
  }
  const text = result.text.trim();
  if (!text) throw new Error('파일에서 텍스트를 찾지 못했습니다.');
  return { text, characters: text.length, pages: result.pages };
}
