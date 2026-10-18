import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import { parseBody, response } from './_shared.mjs';

const MAX = 20 * 1024 * 1024;
export const handler = async event => {
  try {
    const body = parseBody(event), filename = String(body.filename || ''), raw = Buffer.from(String(body.dataBase64 || ''), 'base64');
    if (!raw.length || raw.length > MAX) return response(400, { error: '파일은 20MB 이하만 업로드할 수 있습니다.' });
    const ext = filename.toLowerCase().split('.').pop();
    let text = '';
    if (ext === 'txt') text = raw.toString('utf8').replace(/^\uFEFF/, '');
    else if (ext === 'docx') text = (await mammoth.extractRawText({ buffer: raw })).value;
    else if (ext === 'pdf') text = (await pdfParse(raw)).text;
    else return response(400, { error: 'PDF, DOCX, TXT 파일만 지원합니다.' });
    text = text.trim();
    if (!text) return response(400, { error: '파일에서 텍스트를 찾지 못했습니다.' });
    return response(200, { filename, text, characters: text.length });
  } catch (error) { return response(500, { error: error.message }); }
};
