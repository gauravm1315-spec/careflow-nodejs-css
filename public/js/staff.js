import { api } from './api.js';
import { S, $, $$, esc, ago, fmt, toast, catTag, CAT, ticks, srcChip, finding, disclaimer } from './ui.js';
import { ACTS, INPUTS, leave, go, mount, shell, pageHead } from './core.js';

const RANK = { urgent: 0, priority: 1, clarification: 2, routine: 3 };
const STAGE = { needs_answers: 'Patient answering', ready_for_review: 'Awaiting review', in_review: 'In review', approved: 'Approved' };

// ================= queue =================
let QF = 'open', LIST = [];
const sortList = (a) => [...a].sort((x, y) => (x.stage === 'approved') - (y.stage === 'approved') || RANK[x.category] - RANK[y.category] || new Date(x.createdAt) - new Date(y.createdAt));

export async function viewQueue() {
  LIST = await api('GET', '/cases');
  drawQueue();
  const iv = setInterval(async () => { try { LIST = await api('GET', '/cases'); drawQueue(true); } catch { /* ignore */ } }, 15000);
  leave.fn = () => clearInterval(iv);
}

function drawQueue() {
  const open = LIST.filter((c) => c.stage !== 'approved');
  const fl = { open: open, urgent: open.filter((c) => c.category === 'urgent' || c.category === 'priority'), review: LIST.filter((c) => c.stage === 'ready_for_review' || c.stage === 'in_review'),
    waiting: LIST.filter((c) => c.stage === 'needs_answers'), approved: LIST.filter((c) => c.stage === 'approved'), all: LIST }[QF];
  const rows = sortList(fl);
  const filters = [['open', 'Open'], ['urgent', 'Urgent & priority'], ['review', 'Ready for review'], ['waiting', 'Patient answering'], ['approved', 'Approved'], ['all', 'All']];
  mount(shell(`${pageHead('Review queue', 'Sorted by suggested priority, then waiting time. Categories are decision support — clinicians decide.')}
    <div class="figures"><div><b>${open.length}</b><span>Open cases</span></div><div class="u"><b>${open.filter((c) => c.category === 'urgent').length}</b><span>Urgent warning signs</span></div>
      <div><b>${open.filter((c) => c.category === 'clarification').length}</b><span>Need clarification</span></div><div><b>${LIST.filter((c) => c.stage === 'needs_answers').length}</b><span>Patient still answering</span></div></div>
    <div class="filters">${filters.map(([k, l]) => `<button data-act="qf" data-k="${k}" aria-pressed="${QF === k}">${l}</button>`).join('')}</div>
    ${rows.length ? `<div class="scroll-x panel" style="padding:0"><table><thead><tr><th>Priority</th><th>Case</th><th>Presenting complaint</th><th class="hide-sm">Input</th><th class="hide-sm">Completeness</th><th>Flags</th><th>Stage</th><th>Waiting</th></tr></thead><tbody>
      ${rows.map((c) => `<tr class="qrow ${c.category}" data-act="open-case" data-id="${c.id}" tabindex="0">
        <td>${catTag(c.category, c.suggested)}</td><td class="mono">${c.id}${c.synthetic ? '<br><span class="tiny faint">synthetic</span>' : ''}</td>
        <td><b>${esc(c.chief)}</b><br><span class="small muted">${esc(c.snippet)}${c.snippet.length >= 140 ? '…' : ''}</span></td>
        <td class="hide-sm small">${esc(c.language || '—')}<br><span class="faint">${c.inputMode}</span></td><td class="hide-sm">${ticks(c.completeness)}</td>
        <td>${c.flagCount ? `<b style="color:var(--urgent)">${c.flagCount}</b>` : '<span class="faint">0</span>'}${c.conflicts ? `<br><span class="tiny" style="color:var(--clar)">${c.conflicts} conflict${c.conflicts > 1 ? 's' : ''}</span>` : ''}</td>
        <td class="small">${STAGE[c.stage]}</td><td class="small mono">${ago(c.createdAt)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No cases here.</div>'}`));
}
ACTS.qf = (el) => { QF = el.dataset.k; drawQueue(); };
ACTS['open-case'] = (el) => go(`#/review/${el.dataset.id}`);
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList?.contains('qrow')) ACTS['open-case'](e.target); });

// ================= review =================
let R = null; // { c, summary, notes, note, cat, reason }
const EV = {};

const summaryText = (s) => {
  const F = (x) => (x ? x.text : 'Not reported'), L = (a) => a.map((x) => x.text).join('; ') || 'Not reported';
  return [`Chief complaint: ${s.chiefComplaint}`, `Symptoms: ${s.symptoms.map((x) => x.text).join(', ') || 'None identified'}`, `Onset: ${F(s.onset)}`, `Progression: ${F(s.progression)}`,
    `Severity: ${F(s.severity)}`, `History: ${L(s.history)}`, `Medications: ${L(s.medications)}`, `Allergies: ${L(s.allergies)}`, `Reported negatives: ${s.denied.map((x) => x.text).join(', ') || 'None'}`].join('\n');
};

export async function viewReview(id) {
  let c = await api('GET', `/cases/${id}`);
  if (c.stage === 'ready_for_review' && S.me.role === 'clinician') c = await api('POST', `/cases/${id}/review`, { action: 'open' });
  R = { c, summary: c.review.editedSummary ?? summaryText(c.summary), notes: c.review.notes, note: c.review.note || c.noteDraft, cat: '', reason: '' };
  drawReview();
}

function flagBlock(c) {
  if (!c.flags.length) return '';
  const top = c.flags.some((f) => f.level === 'urgent');
  return `<section class="alert ${top ? '' : 'priority'}" role="alert"><h3>${top ? 'Possible urgent warning signs' : 'Warning signs reported'} · for clinician review</h3><ul>
    ${c.flags.map((f) => `<li><b>${esc(f.label)}</b> <span class="chip ${f.origin === 'ai' ? 'ai' : ''}">${f.origin === 'ai' ? 'AI' : 'rule'}</span> ${srcChip(f.source, c)}<br><q>${esc(f.evidence)}</q>${f.why ? `<br><span class="small">${esc(f.why)}</span>` : ''}</li>`).join('')}</ul>
    <p class="adv">${esc(c.flags[0].advice)}</p></section>`;
}

function evidence(c) {
  const lang = c.message.language.detected, nonEn = c.message.english && !/^english$/i.test(lang || 'English');
  EV['ev-message'] = c.message.text; if (nonEn) EV['ev-english'] = c.message.english;
  const voice = c.message.voice, vf = c.files.find((f) => f.kind === 'audio');
  return `<section class="panel"><p class="label">Patient statement <span class="r">${lang ? esc(lang) : ''}${c.message.language.confidence ? ` · ${Math.round(c.message.language.confidence * 100)}%` : ''}</span></p>
      ${vf ? `<audio controls src="/api/cases/${c.id}/files/${vf.id}" style="width:100%;height:34px;margin-bottom:8px"></audio>` : ''}
      ${voice ? `<p class="small"><span class="chip ai">voice transcript</span> ${voice.confidence != null ? `confidence ${Math.round(voice.confidence * 100)}%` : ''}${voice.uncertain?.length ? ` · <span style="color:var(--clar)">${voice.uncertain.length} unclear phrase(s): ${voice.uncertain.map((u) => esc(u.text)).join(', ')}</span>` : ''}</p>` : ''}
      <div class="evidence quote" id="ev-message">${esc(c.message.text)}</div>
      ${nonEn ? `<p class="label" style="margin-top:14px">English translation <span class="r"><span class="chip ai">machine</span> ${c.message.translation.confidence ? Math.round(c.message.translation.confidence * 100) + '%' : ''}</span></p>
        <div class="evidence quote" id="ev-english">${esc(c.message.english)}</div>
        ${c.message.translation.uncertain.length ? `<p class="small" style="color:var(--clar)">Uncertain terms: ${c.message.translation.uncertain.map((u) => `<b>${esc(u.original)}</b> (${esc(u.note)})`).join('; ')}</p>` : ''}
        <p class="tiny faint">Verify against the original before relying on the translation.</p>` : ''}</section>
    ${c.reports.map((r) => { EV[`ev-report-${r.id}`] = r.rawText; const hasFile = c.files.some((f) => f.id === r.id);
      return `<section class="panel"><p class="label">Report <span class="r">${hasFile ? `<a href="/api/cases/${c.id}/files/${r.id}" target="_blank" rel="noopener">open original ↗</a>` : '<span class="faint">original not stored</span>'}</span></p>
      <p style="margin:0"><b>${esc(r.fileName)}</b> <span class="muted small">${esc(r.docType)}${r.date ? ' · ' + esc(r.date) : ''}${r.confidence != null ? ` · read confidence ${Math.round(r.confidence * 100)}%` : ''}</span></p>
      ${r.values.length ? `<table class="small" style="margin-top:8px"><thead><tr><th>Test</th><th>Value</th><th>Range</th><th>Pg</th></tr></thead><tbody>${r.values.map((v) => `<tr><td>${esc(v.name)}</td><td><b>${esc(v.value)}</b> ${esc(v.unit || '')} ${v.flag === 'high' || v.flag === 'low' ? `<span class="chip warn">${v.flag}</span>` : ''}${v.lowConfidence ? ' <span class="chip warn">low conf.</span>' : ''}</td><td class="muted">${esc(v.range || '—')}</td><td>${v.page}</td></tr>`).join('')}</tbody></table>` : ''}
      ${r.unreadable.length ? `<p class="notice small" style="margin-top:8px">Unreadable: ${esc(r.unreadable.join('; '))}</p>` : ''}
      <details style="margin-top:8px"><summary class="small">Full text as read by AI</summary><div class="evidence small quote" id="ev-report-${r.id}">${esc(r.rawText)}</div></details></section>`; }).join('')}
    ${c.answers.length ? `<section class="panel"><p class="label">Patient follow-up answers</p>${c.answers.map((a) => { EV[`ev-answer-${a.qid}`] = a.answer;
      return `<p class="small" style="margin:0 0 10px"><span class="muted">${esc(a.q)}</span><br>${a.skipped ? '<span class="faint">skipped</span>' : `<span class="evidence" id="ev-answer-${a.qid}">${esc(a.answer)}</span>`}</p>`; }).join('')}</section>` : (c.stage === 'needs_answers' ? '<div class="notice">The patient has not yet answered the follow-up questions.</div>' : '')}`;
}

function summaryPanel(c) {
  const s = c.summary, list = (a) => (a.length ? a.map((x) => finding(x, c)).join('') : '<span class="faint">Not reported</span>');
  return `<section class="panel"><p class="label">Structured summary <span class="r"><span class="chip ai">AI</span> ${ticks(c.completeness)} ${c.completeness}%</span></p>
      ${c.narrative ? `<p style="font:400 16px/1.6 var(--serif);margin:0 0 14px">${esc(c.narrative)}</p>` : ''}
      <dl class="kv"><dt>Chief complaint</dt><dd><b>${esc(s.chiefComplaint)}</b></dd><dt>Symptoms</dt><dd>${list(s.symptoms)}</dd>${s.denied.length ? `<dt>Denies</dt><dd>${list(s.denied)}</dd>` : ''}
      <dt>Onset</dt><dd>${finding(s.onset, c)}</dd><dt>Progression</dt><dd>${finding(s.progression, c)}</dd><dt>Severity</dt><dd>${finding(s.severity, c)}</dd>
      <dt>History</dt><dd>${list(s.history)}</dd><dt>Medications</dt><dd>${list(s.medications)}</dd><dt>Allergies</dt><dd>${list(s.allergies)}</dd>
      ${s.reportFindings.length ? `<dt>From reports</dt><dd>${s.reportFindings.map((f) => `<span class="fnd">${esc(f.text)} ${srcChip(f.source, c)}</span>`).join('')}</dd>` : ''}
      ${s.timeline.length ? `<dt>Timeline</dt><dd>${s.timeline.map((x) => `<div><b>${esc(x.when)}</b> — ${esc(x.event)} ${srcChip(x.source, c)}</div>`).join('')}</dd>` : ''}</dl></section>
    ${s.conflicts.length ? `<section class="panel" style="border-color:var(--clar)"><p class="label">Conflicting information</p>${s.conflicts.map((x) => `<div style="margin-bottom:10px"><b>${esc(x.description)}</b><br>${x.a ? `<span class="fnd">A: ${esc(x.a.text)} ${srcChip(x.a.source, c)}</span>` : ''}${x.b ? `<span class="fnd">B: ${esc(x.b.text)} ${srcChip(x.b.source, c)}</span>` : ''}</div>`).join('')}<p class="tiny faint">Both versions are kept. Nothing was silently corrected.</p></section>` : ''}
    <section class="panel"><p class="label">Missing & uncertain</p>
      ${s.missing.length ? `<p class="small" style="margin:0 0 8px"><b>Missing:</b> ${s.missing.map((m) => `<span class="chip" title="${esc(m.why)}">${esc(m.field)}</span>`).join(' ')}</p>` : '<p class="small muted">Nothing flagged as missing.</p>'}
      ${s.uncertain.length ? `<p class="small" style="margin:0"><b>Uncertain:</b> ${s.uncertain.map((u) => `<span class="chip warn" title="${esc(u.reason)}">${esc(u.item)}</span>`).join(' ')}</p>` : ''}
      ${c.suspicious.length ? `<div class="notice" style="margin-top:10px"><b>Embedded instruction ignored.</b> ${c.suspicious.map((x) => `<q>${esc(x.quote)}</q> ${srcChip(x.source, c)}`).join(' ')}<br><span class="small">The case was escalated to at least “needs clarification”. Patient text can never change triage rules.</span></div>` : ''}</section>
    ${c.clinicianQuestions?.length ? `<section class="panel"><p class="label">Suggested questions to ask <span class="r"><span class="chip ai">AI</span></span></p><ul class="small" style="margin:0;padding-left:18px">${c.clinicianQuestions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul></section>` : ''}`;
}

function decisionPanel(c) {
  const rv = c.review, approved = c.stage === 'approved', cur = rv.finalCategory || c.category, clin = S.me.role === 'clinician';
  const suggestions = [...c.flags.map((f, i) => ({ key: `flag:${f.ruleId}:${i}`, label: `Warning: ${f.label}` })), { key: 'category', label: `Priority: ${CAT[c.category]}` }, ...c.summary.symptoms.map((s) => ({ key: `sym:${s.text}`, label: `Symptom: ${s.text}` }))];
  return `<section class="panel"><p class="label">Review priority</p>
      <p class="small muted" style="margin:0 0 4px">AI + rules suggest ${catTag(c.category)}${c.aiPriority?.rationale ? ` — ${esc(c.aiPriority.rationale)}` : ''}</p>
      ${rv.override ? `<p class="chip human" style="white-space:normal">Overridden ${CAT[rv.override.from]} → ${CAT[rv.override.to]} by ${esc(rv.override.by)}: ${esc(rv.override.reason)}</p>` : ''}
      <div class="catpick">${Object.keys(CAT).map((k) => `<button data-act="pick-cat" data-k="${k}" ${approved ? 'disabled' : ''} aria-pressed="${(R.cat || cur) === k}">${catTag(k)}</button>`).join('')}</div>
      ${R.cat && R.cat !== cur ? `<label class="field"><span>Reason for override (required)</span><input type="text" data-in="reason" value="${esc(R.reason)}" placeholder="e.g. Called patient, symptoms resolved"></label><button class="btn sm" id="ovBtn" data-act="override" ${R.reason.trim() ? '' : 'disabled'}>Save override</button>` : ''}</section>
    <section class="panel"><p class="label">Accept or reject AI suggestions</p>${suggestions.slice(0, 12).map((s) => { const d = rv.decisions[s.key];
      return `<div class="sugg ${d || ''}"><span class="t">${esc(s.label)}</span><span class="row" style="gap:4px"><button class="btn sm ${d === 'accepted' ? '' : 'ghost'}" data-act="decide" data-k="${esc(s.key)}" data-l="${esc(s.label)}" data-v="accepted" ${approved ? 'disabled' : ''} aria-label="Accept">✓</button>
      <button class="btn sm ${d === 'rejected' ? 'danger' : 'ghost'}" data-act="decide" data-k="${esc(s.key)}" data-l="${esc(s.label)}" data-v="rejected" ${approved ? 'disabled' : ''} aria-label="Reject">✕</button></span></div>`; }).join('')}</section>
    <section class="panel"><p class="label">Summary (editable) <span class="r">${rv.editedSummary ? '<span class="chip human">human-edited</span>' : '<span class="chip ai">AI draft</span>'}</span></p>
      <textarea class="noteta" style="min-height:190px" data-in="summary" ${approved ? 'disabled' : ''}>${esc(R.summary)}</textarea></section>
    <section class="panel"><p class="label">Clinician notes <span class="r"><span class="chip human">human</span></span></p><textarea rows="3" data-in="notes" ${approved ? 'disabled' : ''} placeholder="Your own observations…">${esc(R.notes)}</textarea></section>
    <section class="panel"><p class="label">Referral / triage note <span class="r">${approved ? '<span class="chip human">approved</span>' : '<span class="chip warn">draft — not approved</span>'}</span></p>
      <textarea class="noteta" data-in="note" ${approved ? 'disabled' : ''}>${esc(R.note)}</textarea>
      <div class="row" style="margin-top:12px"><button class="btn ghost sm" data-act="save" ${approved ? 'disabled' : ''}>Save edits</button><button class="btn ghost sm" data-act="regen" ${approved ? 'disabled' : ''}>Regenerate draft</button>
        <button class="btn" data-act="approve" ${approved || !clin ? 'disabled' : ''}>✓ Approve final note</button></div>
      ${!clin ? '<p class="tiny faint">Only clinician accounts can approve.</p>' : ''}${approved && rv.approval ? `<p class="small" style="color:var(--human)">Approved by ${esc(rv.approval.by)} · ${fmt(rv.approval.at)}</p>` : ''}
      <div style="margin-top:12px">${disclaimer()}</div></section>`;
}

function drawReview() {
  const c = R.c;
  const keep = window.scrollY;
  mount(shell(`${pageHead(`Case <span class="mono">${c.id}</span>`, `Submitted ${fmt(c.createdAt)} · ${c.inputMode} intake · ${STAGE[c.stage]}${c.synthetic ? ' · synthetic' : ''}`,
      `${catTag(c.review.finalCategory || c.category, !c.review.finalCategory)} <a class="btn ghost sm" href="#/queue">← Queue</a>`)}
    ${flagBlock(c)}
    ${c.ai.intake !== 'ok' ? `<div class="notice"><b>AI extraction unavailable for this case.</b> Warning-sign screening still ran. Read the original statement directly. ${esc(c.ai.errors[0] || '')}</div>` : ''}
    <div class="grid3"><div class="stack"><p class="label" style="margin:0 0 -6px">Source evidence</p>${evidence(c)}</div>
      <div class="stack"><p class="label" style="margin:0 0 -6px">AI summary · click a source tag to jump to the evidence</p>${summaryPanel(c)}</div>
      <div class="stack"><p class="label" style="margin:0 0 -6px">Decision</p>${decisionPanel(c)}</div></div>`));
  window.scrollTo(0, keep);
}

const mark = (raw, q) => { const i = q ? raw.toLowerCase().indexOf(q.toLowerCase()) : -1; return i < 0 ? null : `${esc(raw.slice(0, i))}<mark>${esc(raw.slice(i, i + q.length))}</mark>${esc(raw.slice(i + q.length))}`; };
ACTS['focus-src'] = (el) => {
  const { kind, ref, quote } = el.dataset;
  const ids = [kind === 'report' ? `ev-report-${ref}` : kind === 'answer' ? `ev-answer-${ref}` : 'ev-message', 'ev-english'];
  $$('.evidence').forEach((n) => { if (EV[n.id] !== undefined) n.innerHTML = esc(EV[n.id]); });
  let target = null;
  for (const id of ids) { const raw = EV[id], m = raw && mark(raw, quote); if (m) { $(`#${id}`).innerHTML = m; target = $(`#${id}`); break; } }
  target ||= $(`#${ids[0]}`);
  if (!target) return toast('Evidence not available for this tag.', true);
  target.closest('details')?.setAttribute('open', '');
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash');
  if (!mark(EV[target.id] || '', quote)) toast('Exact wording not found in the original — treat this AI citation as unverified.', true);
};

INPUTS.summary = (el) => { R.summary = el.value; }; INPUTS.notes = (el) => { R.notes = el.value; }; INPUTS.note = (el) => { R.note = el.value; };
INPUTS.reason = (el) => { R.reason = el.value; const b = $('#ovBtn'); if (b) b.disabled = !el.value.trim(); };
ACTS['pick-cat'] = (el) => { R.cat = el.dataset.k; drawReview(); };

async function act(body, ok) {
  try { R.c = await api('POST', `/cases/${R.c.id}/review`, body); if (ok) toast(ok); drawReview(); } catch (e) { toast(e.message, true); }
}
ACTS.decide = (el) => { const cur = R.c.review.decisions[el.dataset.k]; return act({ action: 'decide', key: el.dataset.k, label: el.dataset.l, value: cur === el.dataset.v ? null : el.dataset.v }); };
ACTS.override = async () => { await act({ action: 'override', to: R.cat, reason: R.reason }, 'Priority updated'); R.cat = ''; R.reason = ''; drawReview(); };
ACTS.save = () => act({ action: 'save', summary: R.summary, notes: R.notes, note: R.note }, 'Edits saved');
ACTS.regen = async () => { await act({ action: 'regenerate' }); R.note = R.c.review.note; drawReview(); toast('Draft regenerated'); };
ACTS.approve = async () => {
  if (!confirm('Approve this final note? The case will be locked.')) return;
  await act({ action: 'save', summary: R.summary, notes: R.notes, note: R.note });
  await act({ action: 'approve', note: R.note, notes: R.notes }, 'Final note approved and recorded in the audit log.');
  R.note = R.c.review.note; drawReview();
};

// ================= audit =================
export async function viewAudit() {
  const [rows, ver] = await Promise.all([api('GET', '/audit'), api('GET', '/audit/verify')]);
  let q = '';
  const table = () => rows.filter((a) => `${a.action} ${a.actor} ${a.caseId || ''} ${a.detail}`.toLowerCase().includes(q.toLowerCase()));
  const body = () => table().map((a) => `<tr><td class="small mono" style="white-space:nowrap">${fmt(a.at)}</td><td>${esc(a.actor)}</td><td class="small" style="text-transform:capitalize">${a.role}</td><td><b>${esc(a.action)}</b></td><td class="mono small">${a.caseId || '—'}</td><td class="small muted">${esc(a.detail)}</td><td class="tiny mono faint">${a.hash.slice(0, 8)}</td></tr>`).join('');
  mount(shell(`${pageHead('Audit log', 'Every action by people and by the AI. Entries hold IDs and actions only — never patient text.',
    `<span class="chip ${ver.ok ? 'ai' : 'warn'}" id="vchip">${ver.ok ? `✓ hash chain verified · ${ver.total} entries` : `✕ chain broken at entry ${ver.brokenAt}`}</span><button class="btn ghost sm" data-act="reverify">Re-verify</button>`)}
    <input type="text" id="aq" data-in="aq" placeholder="Filter by action, actor or case ID…" style="max-width:420px;margin-bottom:14px">
    <div class="panel scroll-x" style="padding:0"><table><thead><tr><th>Time</th><th>Actor</th><th>Role</th><th>Action</th><th>Case</th><th>Detail</th><th>Hash</th></tr></thead><tbody id="abody">${body()}</tbody></table></div>`));
  INPUTS.aq = (el) => { q = el.value; $('#abody').innerHTML = body(); };
}
ACTS.reverify = async () => { const v = await api('GET', '/audit/verify'); toast(v.ok ? `Chain intact (${v.total} entries).` : `Chain BROKEN at entry ${v.brokenAt}.`, !v.ok); };

// ================= system (admin) =================
export async function viewSystem() {
  const h = await api('GET', '/health');
  mount(shell(`${pageHead('System', 'Integrations, safety rules and demo data.')}
    <div class="grid2"><section class="panel"><p class="label">AI service</p>
      <p>${h.ai.configured ? '<span class="chip ai">Gemini connected</span>' : '<span class="chip warn">Not configured</span>'}</p>
      <p class="small muted">Model order: <span class="mono">${h.ai.models.map(esc).join(' → ')}</span>. If a model is unavailable or rate-limited the server tries the next one.</p>
      <ul class="small"><li><b>Transcription:</b> Gemini (audio → text, flags unclear words)</li><li><b>Reports:</b> Gemini vision (PDF / photo → values, unreadable parts flagged)</li><li><b>Summary, translation, follow-ups, final summary:</b> Gemini, JSON-only output, every cited quote re-verified against the source</li><li><b>Warning-sign screening:</b> deterministic rules (instant, works without AI)</li></ul>
      ${h.ai.configured ? '' : '<p class="notice small">Set <b>GEMINI_API_KEY</b> in <span class="mono">.env</span> and restart. Until then cases fall back to rules + standard questions.</p>'}</section>
    <section class="panel"><p class="label">Demo data</p><p class="small muted">Restores the synthetic cases and clears everything else, including the audit log.</p><button class="btn danger sm" data-act="reset">Reset demo data</button></section></div>
    <section class="panel" style="margin-top:22px"><p class="label">Warning-sign rules <span class="r">illustrative · not clinically validated · can escalate, never lower</span></p>
      <div class="grid2">${S.rules.map((r) => `<div style="border-bottom:1px solid var(--rule2);padding:6px 0"><b class="small">${esc(r.label)}</b> <span class="cat ${r.level}">${r.level}</span><br><span class="tiny mono faint" style="word-break:break-all">${r.patterns.map((p) => esc(p.s)).join('  |  ')}</span></div>`).join('')}</div></section>`));
}
ACTS.reset = async () => { if (!confirm('Reset all data to the synthetic demo cases?')) return; await api('POST', '/admin/reset-demo', {}); toast('Demo data reset.'); go('#/queue'); };
