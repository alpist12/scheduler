import { API_BASE, MODEL, response } from './_shared.mjs';

export const handler = async () => response(200, {
  ok: true,
  provider: 'NVIDIA NIM',
  configured: Boolean(process.env.NVIDIA_API_KEY),
  model: MODEL,
  apiBase: API_BASE,
  supportedFiles: ['pdf', 'docx', 'txt'],
  runtime: 'Netlify Functions',
});
