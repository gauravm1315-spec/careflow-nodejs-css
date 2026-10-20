// CareFlow server — zero dependencies (Node >= 20).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg, ROOT } from './lib/env.js';
import { data, save, audit, verifyAudit, resetAll, readFile, deleteCaseFiles, uid } from './lib/db.js';
import { makeToken, readToken, patientId, pinOk } from './lib/auth.js';
import { publicRules } from './lib/safety.js';
import * as G from './lib/gemini.js';
import { createCase, submitAnswers, forPatient, listItem, buildNote, LABEL } from './lib/pipeline.js';
import { seedIfEmpty, seedDemo } from './lib/seed.js';

const PUB = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const MAX_BODY = 40 * 1024 * 1024;

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const STAFF = ['clinician', 'admin'];

// uploads waiting to be attached to a case (kept in memory, 30 min TTL)
const pending = new Map();
const sweep = () => { for (const [k, v] of pending) if (Date.now() - v.at > 30 * 60e3) pending.delete(k); };
const takePending = (token, owner, kind) => {
  const p = pending.get(token);
  if (!p || p.owner !== owner || p.kind !== kind) throw new HttpError(400, 'Upload expired — please add it again.');
  return p;
};

const AUDIO_OK = /^audio\/(wav|x-wav|wave|mp3|mpeg|aac|ogg|flac|webm|mp4|x-m4a|aiff)/i;
const REPORT_OK = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const normMime = (m) => String(m || '').split(';')[0].trim().toLowerCase().replace('audio/x-wav', 'audio/wav').replace('audio/wave', 'audio/wav').replace('audio/x-m4a', 'audio/aac');

function getCase(id, user) {
  const c = data().cases.find((x) => x.id === id);
  if (!c) throw new HttpError(404, 'Case not found');
  if (user.role === 'patient' && c.ownerId !== user.id) throw new HttpError(404, 'Case not found'); // do not reveal existence
  return c;
}
const aiMessage = (e) => ({ no_key: 'AI is not configured on the server (missing GEMINI_API_KEY).', bad_key: 'The Gemini API key was rejected.', busy: 'The AI service is busy. Please retry in a moment.', blocked: 'The AI service declined to process this content.' }[e.code] || 'The AI service could not process this right now.');

// ---------------------------------------------------------------------------------------------
const routes = [];
const route = (method, pattern, roles, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), roles, fn });

route('GET', '/api/health', null, () => ({ ok: true, ai: G.aiInfo(), demo: cfg.demoMode, staffPinHint: cfg.demoMode ? cfg.staffPin : null }));
route('GET', '/api/rules', null, () => publicRules());

route('POST', '/api/login', null, ({ body, res }) => {
  const role = ['patient', 'clinician', 'admin'].includes(body.role) ? body.role : null;
  const name = String(body.name || '').trim().slice(0, 60);
  if (!role || !name) throw new HttpError(400, 'Choose a role and enter your name.');
  if (role !== 'patient' && !pinOk(body.pin)) { audit({ name, role }, 'Failed staff sign-in'); throw new HttpError(401, 'Incorrect staff PIN.'); }
  const user = { id: role === 'patient' ? patientId(name) : `s_${name.toLowerCase().replace(/\W+/g, '')}`, name, role };
  res.setHeader('Set-Cookie', `cf_session=${makeToken(user)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
  audit(user, 'Signed in');
  return { user };
});
route('POST', '/api/logout', null, ({ res, user }) => {
  res.setHeader('Set-Cookie', 'cf_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  if (user) audit(user, 'Signed out');
  return { ok: true };
});
route('GET', '/api/me', null, ({ user }) => ({ user }));

// ---- AI helpers used during intake ----
route('POST', '/api/transcribe', ['patient', 'clinician'], async ({ body, user }) => {
  sweep();
  const mime = normMime(body.mime);
  if (!AUDIO_OK.test(mime)) throw new HttpError(400, 'Unsupported audio format.');
  const buf = Buffer.from(String(body.data || ''), 'base64');
  if (buf.length < 800) throw new HttpError(400, 'Recording is empty.');
  if (buf.length > 12 * 1024 * 1024) throw new HttpError(413, 'Recording too long (max ~3 minutes).');
  let t;
  try { t = await G.transcribeAudio({ buf, mime, langHint: body.lang }); } catch (e) { audit(user, 'AI transcription failed', null, e.code); throw new HttpError(e.code === 'no_key' ? 503 : 502, aiMessage(e)); }
  if (!t.speechDetected || !t.text) throw new HttpError(422, 'No clear speech was detected. Please try again or type your symptoms.');
  const token = uid('aud');
  pending.set(token, { kind: 'audio', owner: user.id, buf, mime, at: Date.now(), uncertain: t.uncertain, confidence: t.confidence, language: t.language });
  audit(user, 'Voice transcribed by AI', null, `lang=${t.language}`);
  return { token, text: t.text, language: t.language, confidence: t.confidence, uncertain: t.uncertain };
});

route('POST', '/api/extract-report', ['patient', 'clinician'], async ({ body, user }) => {
  sweep();
  const mime = normMime(body.mime);
  if (!REPORT_OK.includes(mime)) throw new HttpError(400, 'Only PDF, JPG, PNG or WEBP reports are accepted.');
  const buf = Buffer.from(String(body.data || ''), 'base64');
  if (buf.length < 200 || buf.length > 12 * 1024 * 1024) throw new HttpError(413, 'File must be under 12 MB.');
  const fileName = String(body.fileName || 'report').replace(/[^\w.\- ]+/g, '_').slice(0, 80);
  let x;
  try { x = await G.extractReport({ buf, mime, fileName }); } catch (e) { audit(user, 'AI report extraction failed', null, e.code); throw new HttpError(e.code === 'no_key' ? 503 : 502, aiMessage(e)); }
  const token = uid('rpt');
  pending.set(token, { kind: 'report', owner: user.id, buf, mime, fileName, extraction: x, at: Date.now() });
  audit(user, 'Report read by AI', null, `${x.values.length} values`);
  return { token, fileName, ...x };
});

// ---- cases ----
route('POST', '/api/cases', ['patient'], async ({ body, user }) => {
  if (body.consent !== true) throw new HttpError(400, 'Explicit consent is required.');
  const p = { audio: null, reports: [] };
  if (body.audioToken) p.audio = takePending(body.audioToken, user.id, 'audio');
  for (const t of (body.reportTokens || []).slice(0, 5)) p.reports.push(takePending(t, user.id, 'report'));
  const c = await createCase({ user, body, pending: p });
  for (const t of [body.audioToken, ...(body.reportTokens || [])]) pending.delete(t);
  data().cases.unshift(c); save();
  audit(user, 'Consent given', c.id);
  audit(user, 'Case created', c.id, `mode=${c.inputMode}`);
  audit({ name: 'CareFlow AI', role: 'system' }, c.ai.intake === 'ok' ? 'AI intake analysis' : 'AI intake unavailable — fallback', c.id, c.ai.model || c.ai.errors[0] || '');
  if (c.flags.length) audit({ name: 'CareFlow AI', role: 'system' }, 'Warning-sign alert raised', c.id, c.flags.map((f) => f.label).join('; '));
  return forPatient(c);
});

route('GET', '/api/cases', null, ({ user }) => {
  need(user);
  const cs = data().cases.filter((c) => STAFF.includes(user.role) || c.ownerId === user.id);
  return cs.map((c) => (STAFF.includes(user.role) ? listItem(c) : { id: c.id, createdAt: c.createdAt, stage: c.stage, chief: c.summary.chiefComplaint }));
});

route('GET', '/api/cases/:id', null, ({ user, params }) => {
  need(user);
  const c = getCase(params.id, user);
  if (user.role === 'patient') return forPatient(c);
  audit(user, 'Case accessed', c.id);
  return c; // full record for staff
});

route('POST', '/api/cases/:id/answers', ['patient'], async ({ user, params, body }) => {
  const c = getCase(params.id, user);
  if (c.stage !== 'needs_answers') throw new HttpError(409, 'This case is no longer accepting answers.');
  if (!Array.isArray(body.answers)) throw new HttpError(400, 'No answers supplied.');
  await submitAnswers({ c, answers: body.answers });
  save();
  audit(user, 'Follow-up answers submitted', c.id, `${c.answers.filter((a) => !a.skipped).length}/${c.answers.length} answered`);
  audit({ name: 'CareFlow AI', role: 'system' }, c.ai.final === 'ok' ? 'AI final summary generated' : 'AI final summary unavailable', c.id, c.ai.model || '');
  return forPatient(c);
});

route('POST', '/api/cases/:id/withdraw', ['patient', 'admin'], ({ user, params }) => {
  const c = getCase(params.id, user);
  deleteCaseFiles(c.id);
  data().cases = data().cases.filter((x) => x.id !== c.id);
  save();
  audit(user, 'Consent withdrawn', c.id);
  audit(user, 'Case data deleted', c.id, 'Message, recordings, reports, summaries removed');
  return { ok: true };
});

route('GET', '/api/cases/:id/files/:fid', null, ({ user, params, res }) => {
  need(user);
  const c = getCase(params.id, user);
  const f = c.files.find((x) => x.id === params.fid);
  const buf = f && readFile(c.id, f.id);
  if (!buf) throw new HttpError(404, 'File not found');
  audit(user, 'File opened', c.id, f.kind);
  res.writeHead(200, { 'content-type': f.mime, 'content-length': buf.length, 'content-disposition': `inline; filename="${f.fileName}"`, 'cache-control': 'private, no-store' });
  res.end(buf);
  return undefined;
});

// ---- clinician review actions ----
route('POST', '/api/cases/:id/review', STAFF, ({ user, params, body }) => {
  const c = getCase(params.id, user);
  const rv = c.review;
  const locked = c.stage === 'approved';
  const guard = () => { if (locked) throw new HttpError(409, 'Case is approved and locked.'); };
  switch (body.action) {
    case 'open':
      if (c.stage === 'ready_for_review') c.stage = 'in_review';
      audit(user, 'Case opened for review', c.id);
      break;
    case 'decide': {
      guard();
      if (!['accepted', 'rejected', null].includes(body.value)) throw new HttpError(400, 'Bad decision');
      if (body.value === null) delete rv.decisions[body.key]; else rv.decisions[String(body.key).slice(0, 120)] = body.value;
      audit(user, `AI suggestion ${body.value || 'cleared'}`, c.id, String(body.label || '').slice(0, 120));
      break;
    }
    case 'override': {
      guard();
      if (!(body.to in LABEL) || !String(body.reason || '').trim()) throw new HttpError(400, 'A category and a reason are required.');
      const from = rv.finalCategory || c.category;
      rv.finalCategory = body.to;
      rv.override = { by: user.name, at: new Date().toISOString(), reason: String(body.reason).slice(0, 300), from, to: body.to };
      audit(user, 'Priority overridden', c.id, `${from} → ${body.to}`);
      break;
    }
    case 'save':
      guard();
      if (typeof body.summary === 'string') rv.editedSummary = body.summary.slice(0, 8000);
      if (typeof body.notes === 'string') rv.notes = body.notes.slice(0, 4000);
      if (typeof body.note === 'string') rv.note = body.note.slice(0, 12000);
      audit(user, 'Review edits saved', c.id);
      break;
    case 'regenerate':
      guard();
      rv.note = buildNote(c);
      audit(user, 'Note draft regenerated', c.id);
      break;
    case 'approve': {
      guard();
      if (user.role !== 'clinician') throw new HttpError(403, 'Only clinicians can approve a note.');
      const at = new Date().toISOString();
      const base = (typeof body.note === 'string' && body.note.trim() ? body.note : rv.note || buildNote(c)).slice(0, 12000);
      const final = /^Approval status:.*$/m.test(base) ? base.replace(/^Approval status:.*$/m, `Approval status: APPROVED by ${user.name} at ${at}`) : `${base}\nApproval status: APPROVED by ${user.name} at ${at}`;
      rv.note = final; rv.approval = { by: user.name, at, note: final };
      if (typeof body.notes === 'string') rv.notes = body.notes.slice(0, 4000);
      c.stage = 'approved';
      audit(user, 'Final note approved', c.id, `category=${rv.finalCategory || c.category}`);
      break;
    }
    default: throw new HttpError(400, 'Unknown action');
  }
  if (!rv.note) rv.note = c.noteDraft;
  c.updatedAt = new Date().toISOString();
  save();
  return c;
});

// ---- audit / admin ----
route('GET', '/api/audit', STAFF, () => data().audit.slice(-400).reverse());
route('GET', '/api/audit/verify', STAFF, () => verifyAudit());
route('POST', '/api/admin/reset-demo', ['admin'], ({ user }) => { resetAll(); seedDemo(); audit(user, 'Demo data reset'); return { ok: true }; });

function need(user) { if (!user) throw new HttpError(401, 'Please sign in.'); }

// ---------------------------------------------------------------------------------------------
async function readBody(req) {
  const chunks = []; let n = 0;
  for await (const ch of req) { n += ch.length; if (n > MAX_BODY) throw new HttpError(413, 'Upload too large'); chunks.push(ch); }
  if (!n) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUB, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUB, 'index.html'); // SPA fallback
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  fs.createReadStream(file).pipe(res);
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    const user = readToken(req.headers.cookie);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      if (r.roles && (!user || !r.roles.includes(user.role))) throw new HttpError(user ? 403 : 401, user ? 'Your role cannot do this.' : 'Please sign in.');
      if (req.method === 'POST' && Number(req.headers['content-length'] || 0) > 0 && !/application\/json/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'JSON only');
      const body = req.method === 'GET' ? {} : await readBody(req);
      const out = await r.fn({ req, res, user, params: m.groups || {}, body, url });
      if (out === undefined) return undefined; // handler wrote the response
      const json = JSON.stringify(out);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(json);
    }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: status === 500 ? 'Something went wrong on the server.' : e.message }));
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedIfEmpty();
  server.listen(cfg.port, () => {
    console.log(`\n  CareFlow running → http://localhost:${cfg.port}`);
    console.log(`  Gemini: ${cfg.geminiKey ? `configured (models: ${cfg.models.join(' → ')})` : 'NOT configured — set GEMINI_API_KEY in .env (rules-only fallback active)'}`);
    console.log(`  Staff PIN: ${cfg.demoMode ? cfg.staffPin : '(hidden)'}\n`);
  });
}
