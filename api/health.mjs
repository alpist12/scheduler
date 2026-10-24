import { ANALYSIS_TIMEOUT_MS, API_BASE, CHAT_MODEL, FALLBACK_MODEL, MODEL, preflight, response } from './_shared.mjs';

export const handler = async event => {
  const pre = preflight(event); if (pre) return pre;
  return response(200, {
  ok: true,
  version: '20260913-agent',
  analysisTimeoutMs: ANALYSIS_TIMEOUT_MS,
  provider: 'NVIDIA NIM',
  configured: Boolean(process.env.NVIDIA_API_KEY),
  model: MODEL,
  chatModel: CHAT_MODEL,
  fallbackModel: FALLBACK_MODEL,
  apiBase: API_BASE,
  supportedFiles: ['pdf', 'docx', 'txt'],
  runtime: 'Sites Worker',
}, event);
};
