// Tiny .env loader (no dependencies).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = root;

try {
  const raw = fs.readFileSync(path.join(root, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
} catch { /* no .env — fine */ }

export const cfg = {
  port: Number(process.env.PORT) || 3000,
  geminiKey: process.env.GEMINI_API_KEY || '',
  geminiBase: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
  models: [process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    ...(process.env.GEMINI_FALLBACK_MODELS || 'gemini-2.5-flash-lite,gemini-2.0-flash').split(',')]
    .map((s) => s.trim()).filter(Boolean).filter((m, i, a) => a.indexOf(m) === i),
  staffPin: process.env.STAFF_PIN || '2468',
  demoMode: process.env.DEMO_MODE !== '0',
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
};
