// Minimal fake of the Gemini generateContent endpoint, keyed on the TASK in the system prompt.
import http from 'node:http';

const analysis = (msg) => ({
  language: { detected: /mujhe|bukhar/i.test(msg) ? 'Hinglish' : 'English', confidence: 0.9 },
  english_text: /mujhe/i.test(msg) ? 'I have had fever for 3 days.' : msg,
  translation: { confidence: 0.85, uncertain_terms: [] },
  chief_complaint: 'Fever and headache',
  symptoms: [{ name: 'Fever', quote: /mujhe/i.test(msg) ? 'Mujhe 3 din se bukhar hai' : 'I have a fever for 3 days', source: 'message', confidence: 0.9 },
             { name: 'Invented symptom', quote: 'this quote is not in the message at all', source: 'message', confidence: 0.9 }],
  denied_symptoms: [], onset: null, progression: null, severity: null, history: [], medications: [], allergies: [],
  missing: [{ field: 'Progression', why_it_matters: 'trend' }], conflicts: [], uncertain: [], suspicious_instructions: [],
  red_flags: [], ai_priority: { level: 'routine', rationale: 'mild', confidence: 0.8 },
  follow_up_questions: [
    { question: 'Is it getting worse?', question_local: 'Kya yeh badh raha hai?', reason: 'progression', answer_type: 'yes_no', options: [], priority: 1 },
    { question: 'Any allergies?', question_local: 'Koi allergy?', reason: 'allergy unknown', answer_type: 'text', options: [], priority: 2 }],
});

export function startFake(port = 0) {
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    const body = JSON.parse(b || '{}');
    const sys = body.systemInstruction.parts[0].text;
    const user = body.contents[0].parts.map((p) => p.text || '').join('\n');
    const task = /TASK: (\w+)/.exec(sys)?.[1];
    calls.push({ task, user, url: req.url, key: req.headers['x-goog-api-key'] });
    let out;
    if (task === 'analyze_intake') out = analysis(/<patient_message>\n([\s\S]*?)\n<\/patient_message>/.exec(user)[1]);
    else if (task === 'finalize_summary') out = { ...analysis('I have a fever for 3 days'), progression: { text: 'Getting worse', quote: 'yes', source: 'answer:q1', confidence: 0.9 },
      narrative: 'Fever for 3 days, worsening.', patient_recap: { text: 'You told us you have had fever.', needs_confirmation: [] }, clinician_questions: ['Travel history?'], answer_effects: [] };
    else if (task === 'transcribe_audio') out = { text: 'Mujhe 3 din se bukhar hai', language: 'Hinglish', confidence: 0.8, speech_detected: true, uncertain: [] };
    else if (task === 'extract_report') out = { is_medical_document: true, doc_type: 'Lab', report_date: '2026-10-01', raw_text: '[Page 1] HbA1c 7.1 %', values: [{ name: 'HbA1c', value: '7.1', unit: '%', page: 1, confidence: 0.9 }], unreadable: [], overall_confidence: 0.9 };
    else { res.writeHead(400); return res.end('bad task'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }));
  });
  return new Promise((r) => srv.listen(port, () => r({ srv, calls, port: srv.address().port })));
}
