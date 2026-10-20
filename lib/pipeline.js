import * as G from './gemini.js';
import { screen, detectInjection, norm, maxLevel, LEVEL_RANK } from './safety.js';
import { nextCaseId, saveFile, uid } from './db.js';
import { cfg } from './env.js';

export const LABEL = { urgent: 'Urgent review', priority: 'Priority review', clarification: 'Needs clarification', routine: 'Routine review' };
const DISCLAIMER = 'AI-generated decision-support content. Not a diagnosis. Requires review by a qualified healthcare professional.';

// ---- deterministic helpers -------------------------------------------------------------------
export function completeness(s) {
  const parts = [s.symptoms.length > 0, !!s.onset, !!s.progression, !!s.severity, s.history.length > 0, s.medications.length > 0, s.allergies.length > 0];
  return Math.round((parts.filter(Boolean).length / parts.length) * 100);
}

const dedupeFlags = (flags) => {
  const seen = [];
  return flags.filter((f) => {
    const key = norm(f.evidence).slice(0, 60);
    if (seen.some((k) => (key && k && (k.includes(key) || key.includes(k))) )) return false;
    seen.push(key);
    return true;
  });
};

/** AI may escalate, never lower below deterministic rules. Missing info never means safe. */
export function computeCategory(c) {
  let level = maxLevel('routine', ...c.flags.map((f) => f.level), c.aiPriority?.level === 'urgent' || c.aiPriority?.level === 'priority' ? c.aiPriority.level : 'routine');
  const s = c.summary;
  if (level === 'routine' && (s.conflicts.length || s.uncertain.length || c.suspicious.length || c.completeness < 60 || !s.symptoms.length
    || c.aiPriority?.level === 'clarification' || c.ai.intake !== 'ok')) level = 'clarification';
  return level;
}

const FALLBACK_Q = [
  ['onset', 'When did the symptoms first begin?', 'लक्षण कब शुरू हुए?', 'Onset not reported', 'text'],
  ['progression', 'Are the symptoms getting better, worse, or staying the same?', 'क्या लक्षण बेहतर हो रहे हैं, बिगड़ रहे हैं, या वैसे ही हैं?', 'Progression not reported', 'choice', ['Better', 'Worse', 'Same']],
  ['severity', 'How severe are the symptoms, from 0 (none) to 10 (worst)?', 'लक्षण कितने गंभीर हैं, 0 (कुछ नहीं) से 10 (सबसे ज़्यादा)?', 'Severity not reported', 'scale_0_10'],
  ['history', 'Do you have any long-term medical conditions (for example diabetes, blood pressure, asthma)?', 'क्या आपको कोई पुरानी बीमारी है (जैसे शुगर, बीपी, दमा)?', 'No medical history provided', 'text'],
  ['medications', 'Are you currently taking any medicines?', 'क्या आप अभी कोई दवा ले रहे हैं?', 'Medication list missing', 'text'],
  ['allergies', 'Do you have any allergies to medicines or food?', 'क्या आपको किसी दवा या खाने से एलर्जी है?', 'Allergy status unknown', 'yes_no'],
];
export const fallbackFollowUps = (summary, hindi) =>
  FALLBACK_Q.filter(([k]) => !summary[k] || (Array.isArray(summary[k]) && !summary[k].length))
    .map(([, q, hi, reason, type, options], i) => ({ id: `q${i + 1}`, q, local: hindi ? hi : q, reason, type, options: options || [], priority: i + 1 }));

const MISSING_DEFAULT = (s) => [
  !s.symptoms.length && 'Identifiable symptoms', !s.onset && 'Symptom onset / duration', !s.progression && 'Progression', !s.severity && 'Severity',
  !s.history.length && 'Relevant medical history', !s.medications.length && 'Current medications', !s.allergies.length && 'Allergies',
].filter(Boolean).map((field) => ({ field, why: '' }));

const emptySummary = () => ({ chiefComplaint: 'Insufficient information', symptoms: [], denied: [], onset: null, progression: null, severity: null,
  history: [], medications: [], allergies: [], timeline: [], reportFindings: [], missing: [], conflicts: [], uncertain: [], });

// ---- note builder (deterministic; AI only contributes the narrative) -----------------------------
const F = (x) => (x ? x.text : 'Not reported');
const L = (a) => a.map((x) => x.text).join('; ') || 'Not reported';
export function summaryToText(s) {
  return [
    `Chief complaint: ${s.chiefComplaint}`,
    `Symptoms: ${s.symptoms.map((x) => x.text).join(', ') || 'None identified'}`,
    `Onset: ${F(s.onset)}`, `Progression: ${F(s.progression)}`, `Severity: ${F(s.severity)}`,
    `History: ${L(s.history)}`, `Medications: ${L(s.medications)}`, `Allergies: ${L(s.allergies)}`,
    `Reported negatives: ${s.denied.map((x) => x.text).join(', ') || 'None'}`,
  ].join('\n');
}

export function buildNote(c) {
  const s = c.summary, cat = c.review?.finalCategory || c.category;
  const lim = [];
  if (c.message.language.detected && !/^english/i.test(c.message.language.detected)) lim.push(`message in ${c.message.language.detected}, machine-translated (confidence ${Math.round((c.message.translation.confidence ?? 0) * 100)}%) — verify against original`);
  if (c.message.voice?.uncertain?.length) lim.push(`${c.message.voice.uncertain.length} unclear phrase(s) in voice transcript`);
  c.reports.forEach((r) => r.unreadable.length && lim.push(`${r.fileName}: ${r.unreadable.join(', ')}`));
  const unv = [...c.flags.map((f) => f.source), ...[...s.symptoms, s.onset, s.progression, s.severity].filter(Boolean).map((f) => f.source)].filter((x) => x && !x.verified && !x.translated).length;
  if (unv) lim.push(`${unv} AI-cited source quote(s) could not be matched to the original text — check evidence`);
  if (c.ai.intake !== 'ok') lim.push('AI extraction unavailable for intake — summary is limited');
  if (c.ai.final === 'failed') lim.push('AI final summary unavailable — patient answers attached verbatim');
  return [
    'CAREFLOW — REFERRAL / TRIAGE NOTE (DRAFT)',
    `Case: ${c.id}    Created: ${c.createdAt}`,
    '',
    `Chief complaint: ${s.chiefComplaint}`,
    c.narrative ? `Overview: ${c.narrative}` : null,
    `Timeline: onset — ${F(s.onset)}; progression — ${F(s.progression)}; severity — ${F(s.severity)}`,
    `Reported symptoms: ${s.symptoms.map((x) => x.text).join(', ') || 'none identified'}${s.denied.length ? `; denies ${s.denied.map((x) => x.text).join(', ')}` : ''}`,
    `History: ${L(s.history)}`, `Medications: ${L(s.medications)}`, `Allergies: ${L(s.allergies)}`,
    c.reports.length ? `Reports: ${c.reports.map((r) => `${r.fileName} (${r.docType}${r.date ? ', ' + r.date : ''})`).join('; ')}` : null,
    s.reportFindings.length ? `Report findings: ${s.reportFindings.map((f) => f.text).join('; ')}` : null,
    `Possible warning signs: ${c.flags.length ? c.flags.map((f) => `${f.label} [“${f.evidence}”]`).join('; ') : 'none recognised in available information'}`,
    c.answers.length ? `Patient follow-up answers:\n${c.answers.map((a) => `  - ${a.q} → ${a.skipped ? '(skipped)' : a.answer}`).join('\n')}` : null,
    `Missing information: ${s.missing.map((m) => m.field).join('; ') || 'none'}`,
    `Conflicting information: ${s.conflicts.map((x) => x.description).join('; ') || 'none'}`,
    `Uncertainty / limitations: ${[...s.uncertain.map((u) => u.item), ...lim].join('; ') || 'none'}`,
    c.suspicious.length ? `Suspicious embedded instructions (ignored): ${c.suspicious.map((x) => `“${x.quote}”`).join('; ')}` : null,
    c.clinicianQuestions?.length ? `Suggested questions for clinician: ${c.clinicianQuestions.join(' | ')}` : null,
    `Suggested review priority: ${LABEL[cat]}${c.review?.override ? ` (overridden from ${LABEL[c.review.override.from]}: ${c.review.override.reason})` : ' (AI + rules suggestion)'}`,
    `Reviewer notes: ${c.review?.notes || '—'}`,
    'Approval status: NOT APPROVED',
    '', DISCLAIMER,
  ].filter((l) => l !== null).join('\n');
}

// ---- case creation ---------------------------------------------------------------------------
const clean = (t) => String(t || '').replace(/\u0000/g, '').trim().slice(0, 6000);

export async function createCase({ user, body, pending }) {
  const text = clean(body.text);
  if (!text && !pending.reports.length) throw Object.assign(new Error('Please describe the symptoms or attach a report.'), { status: 400 });
  const id = nextCaseId();
  const uiLang = body.uiLang === 'hi' ? 'hi' : 'en';
  const files = [], reports = [];
  const mode = pending.audio ? (pending.reports.length ? 'mixed' : 'voice') : pending.reports.length && !text ? 'report' : pending.reports.length ? 'mixed' : 'text';

  if (pending.audio) {
    const fid = uid('f'); saveFile(id, fid, pending.audio.buf);
    files.push({ id: fid, kind: 'audio', fileName: 'voice-recording.wav', mime: pending.audio.mime, size: pending.audio.buf.length });
    pending.audio.fileId = fid;
  }
  for (const p of pending.reports) {
    const fid = uid('f'); saveFile(id, fid, p.buf);
    files.push({ id: fid, kind: 'report', fileName: p.fileName, mime: p.mime, size: p.buf.length });
    const x = p.extraction;
    reports.push({ id: fid, fileName: p.fileName, docType: x.docType, date: x.date, values: x.values, rawText: x.rawText, unreadable: x.unreadable, confidence: x.confidence, isMedical: x.isMedical,
      medications: x.medications, statements: x.statements });
  }

  const corpus = { message: text, reports: Object.fromEntries(reports.map((r) => [r.id, r.rawText])), answers: {} };
  const c = {
    id, ownerId: user.id, ownerName: user.name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    uiLang, inputMode: mode, consent: { at: new Date().toISOString(), version: 'v1', withdrawnAt: null }, stage: 'needs_answers',
    ai: { configured: !!cfg.geminiKey, model: null, intake: 'skipped', final: 'pending', errors: [] },
    message: { text, english: null, language: { detected: null, confidence: null }, translation: { confidence: null, uncertain: [] },
      voice: pending.audio ? { fileId: pending.audio.fileId, uncertain: pending.audio.uncertain, confidence: pending.audio.confidence, language: pending.audio.language } : null },
    files, reports, summary: emptySummary(), flags: [], suspicious: [], followUps: [], answers: [], patientRecap: null, narrative: '', clinicianQuestions: [],
    aiPriority: null, category: 'clarification', completeness: 0, noteDraft: '', synthetic: false,
    review: { decisions: {}, finalCategory: null, override: null, editedSummary: null, notes: '', note: '', approval: null },
  };

  // 1) deterministic screening — instant, independent of AI
  let flags = screen(text, 'message');
  for (const r of reports) flags.push(...screen(r.rawText, 'report', r.id));
  c.suspicious = detectInjection(text);

  // 2) AI analysis (degrades gracefully)
  try {
    const { json, model } = await G.analyzeIntake({ message: text, inputMode: mode, reports, uiLang });
    c.ai.model = model; c.ai.intake = 'ok';
    c.summary = G.normalizeSummary(json, corpus);
    c.message.english = String(json.english_text || '').slice(0, 6000) || null;
    c.message.language = { detected: String(json.language?.detected || '').slice(0, 60) || null, confidence: Number(json.language?.confidence) || null };
    c.message.translation = { confidence: Number(json.translation?.confidence) || null,
      uncertain: (json.translation?.uncertain_terms || []).slice(0, 8).map((t) => ({ original: String(t.original || '').slice(0, 80), note: String(t.note || '').slice(0, 160) })) };
    if (c.message.english && !/^english$/i.test(c.message.language.detected || 'English')) flags.push(...screen(c.message.english, 'message', null, { translated: true }));
    flags.push(...G.normalizeFlags(json, corpus));
    const sus = G.normalizeSuspicious(json, corpus);
    c.suspicious = [...c.suspicious, ...sus.filter((x) => !c.suspicious.some((y) => norm(y.quote) === norm(x.quote)))];
    c.aiPriority = G.normalizePriority(json);
    c.followUps = G.normalizeFollowUps(json);
    if (!c.summary.missing.length) c.summary.missing = MISSING_DEFAULT(c.summary);
  } catch (e) {
    c.ai.intake = 'failed'; c.ai.errors.push(`${e.code || 'error'}: ${e.message}`);
    c.summary.missing = MISSING_DEFAULT(c.summary);
  }
  if (!c.followUps.length && c.ai.intake !== 'ok') c.followUps = fallbackFollowUps(c.summary, uiLang === 'hi');

  c.flags = dedupeFlags(flags.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]));
  c.completeness = completeness(c.summary);
  c.category = computeCategory(c);
  c.review.editedSummary = null;
  c.noteDraft = buildNote(c);
  if (!c.followUps.length) { c.stage = 'ready_for_review'; c.ai.final = c.ai.intake === 'ok' ? 'ok' : 'failed'; }
  return c;
}

// ---- patient answers -> final summary --------------------------------------------------------
export async function submitAnswers({ c, answers }) {
  const byQ = new Map(c.followUps.map((q) => [q.id, q]));
  const now = new Date().toISOString();
  c.answers = c.followUps.map((q) => {
    const a = answers.find((x) => x.qid === q.id) || {};
    const ans = String(a.answer ?? '').replace(/\u0000/g, '').trim().slice(0, 1000);
    return { qid: q.id, q: q.q, local: q.local, type: q.type, answer: ans, skipped: !!a.skipped || !ans, at: now };
  });
  const corpus = { message: c.message.text, reports: Object.fromEntries(c.reports.map((r) => [r.id, r.rawText])),
    answers: Object.fromEntries(c.answers.filter((a) => !a.skipped).map((a) => [a.qid, a.answer])) };

  // deterministic screening of free-text answers (yes/no answers are interpreted by the model with their question)
  const extra = [];
  for (const a of c.answers) if (!a.skipped && a.type === 'text') extra.push(...screen(a.answer, 'answer', a.qid));
  for (const a of c.answers) c.suspicious.push(...detectInjection(a.answer, 'answer', a.qid));

  try {
    const { json, model } = await G.finalizeSummary({ message: c.message.text, inputMode: c.inputMode, reports: c.reports, answers: c.answers, uiLang: c.uiLang,
      previous: { summary: c.summary, flags: c.flags.map((f) => f.label) } });
    c.ai.model = model; c.ai.final = 'ok';
    c.summary = G.normalizeSummary(json, corpus);
    if (!c.summary.missing.length) c.summary.missing = MISSING_DEFAULT(c.summary);
    c.narrative = String(json.narrative || '').slice(0, 800);
    c.clinicianQuestions = (json.clinician_questions || []).slice(0, 5).map((q) => String(q).slice(0, 250));
    const pr = json.patient_recap || {};
    c.patientRecap = { text: String(pr.text || '').slice(0, 1500), needsConfirmation: (pr.needs_confirmation || []).slice(0, 6).map((x) => String(x).slice(0, 200)) };
    c.aiPriority = G.normalizePriority(json);
    extra.push(...G.normalizeFlags(json, corpus));
    for (const s of G.normalizeSuspicious(json, corpus)) if (!c.suspicious.some((y) => norm(y.quote) === norm(s.quote))) c.suspicious.push(s);
  } catch (e) {
    c.ai.final = 'failed'; c.ai.errors.push(`final: ${e.code || 'error'}: ${e.message}`);
  }
  // flags are only ever added, never auto-removed
  c.flags = dedupeFlags([...c.flags, ...extra].sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]));
  c.completeness = completeness(c.summary);
  c.category = computeCategory(c);
  c.noteDraft = buildNote(c);
  c.stage = 'ready_for_review';
  c.updatedAt = now;
  return c;
}

// ---- role projections ------------------------------------------------------------------------
export function forPatient(c) {
  return {
    id: c.id, createdAt: c.createdAt, stage: c.stage, uiLang: c.uiLang, inputMode: c.inputMode, consent: c.consent,
    language: c.message.language.detected, followUps: c.followUps, answers: c.answers, patientRecap: c.patientRecap,
    urgent: c.flags.filter((f) => f.level === 'urgent' || f.level === 'priority').map((f) => ({ label: f.label, advice: f.advice, level: f.level })),
    summary: c.stage === 'needs_answers' ? null : c.summary, ai: { intake: c.ai.intake, final: c.ai.final },
    approved: c.stage === 'approved', message: { text: c.message.text }, reports: c.reports.map((r) => ({ id: r.id, fileName: r.fileName, docType: r.docType })),
  };
}
export function listItem(c) {
  return { id: c.id, createdAt: c.createdAt, updatedAt: c.updatedAt, stage: c.stage, category: c.review.finalCategory || c.category, suggested: !c.review.finalCategory,
    chief: c.summary.chiefComplaint, language: c.message.language.detected, inputMode: c.inputMode, completeness: c.completeness, flagCount: c.flags.length,
    snippet: c.message.text.slice(0, 140), synthetic: c.synthetic, aiOk: c.ai.intake === 'ok', conflicts: c.summary.conflicts.length, answered: c.answers.length };
}
