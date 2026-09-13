import { API_BASE, CHAT_MODEL, MODEL, ANALYSIS_TIMEOUT_MS, response } from './_shared.mjs';

export const handler = async () => response(200, {
  ok: true,
  version: '20260913-agent',
  analysisTimeoutMs: ANALYSIS_TIMEOUT_MS,
  provider: 'NVIDIA NIM',
  configured: Boolean(process.env.NVIDIA_API_KEY),
  model: MODEL,
  chatModel: CHAT_MODEL,
  apiBase: API_BASE,
  supportedFiles: ['pdf', 'docx', 'txt'],
  runtime: 'Netlify Functions',
});
