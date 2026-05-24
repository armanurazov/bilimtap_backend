'use strict';

// ============================================================
// BILIMTAP — Backend Server
// Single-file Express server
//
// Contains two feature sets:
//   1. BilimTap Validation Campaign  (original)
//   2. IELTS Prep Platform           (updated)
//
// Setup:
//   npm install express @supabase/supabase-js cors helmet multer openai
//
// Required environment variables (Railway dashboard):
//   SUPABASE_URL        — Supabase project URL
//   SUPABASE_KEY        — service_role key (not anon key)
//   ALLOWED_ORIGIN      — frontend URL e.g. https://bilimtap.vercel.app
//   OPENAI_WHISPER_KEY  — OpenAI key for Whisper transcription
//   OPENAI_GPT_KEY      — OpenAI key for GPT scoring (can be same key)
//   PORT                — set automatically by Railway
// ============================================================

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const multer     = require('multer');
const { createClient } = require('@supabase/supabase-js');
const OpenAI     = require('openai');
require('dotenv').config();

// ─── ENV VALIDATION ─────────────────────────────────────────
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_KEY', 'ALLOWED_ORIGIN', 'OPENAI_WHISPER_KEY', 'OPENAI_GPT_KEY'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`[FATAL] Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const {
  SUPABASE_URL,
  SUPABASE_KEY,
  ALLOWED_ORIGIN,
  OPENAI_WHISPER_KEY,
  OPENAI_GPT_KEY,
  PORT = 3000,
} = process.env;

// ─── SUPABASE CLIENT ────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── OPENAI CLIENTS ─────────────────────────────────────────
const openaiWhisper = new OpenAI({ apiKey: OPENAI_WHISPER_KEY });
const openaiGpt     = new OpenAI({ apiKey: OPENAI_GPT_KEY });

// ─── MULTER (in-memory audio upload) ────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 25 * 1024 * 1024 }, // 25 MB — Whisper max
  fileFilter(_req, file, cb) {
    const allowed = [
      'audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg',
      'audio/mp4', 'audio/x-m4a', 'audio/flac', 'video/webm',
    ];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`Unsupported audio type: ${file.mimetype}`));
  },
});

// ─── EXPRESS SETUP ──────────────────────────────────────────
const app = express();

app.use(helmet());

app.use(cors({
  origin: true,
  methods: ['POST', 'GET'],
  allowedHeaders: ['Content-Type'],
}));

// multer handles multipart; express.json handles the rest
app.use((req, _res, next) => {
  if (req.is('multipart/form-data')) return next();
  express.json({ limit: '16kb' })(req, _res, next);
});


// ============================================================
// HELPERS — BILIMTAP (original)
// ============================================================

function parseDevice(ua = '') {
  ua = ua.toLowerCase();
  if (/ipad|tablet|playbook|silk/.test(ua))             return 'tablet';
  if (/mobile|iphone|ipod|android|blackberry/.test(ua)) return 'mobile';
  return 'desktop';
}

function parseBrowser(ua = '') {
  ua = ua.toLowerCase();
  if (ua.includes('edg/'))    return 'edge';
  if (ua.includes('opr/'))    return 'opera';
  if (ua.includes('chrome'))  return 'chrome';
  if (ua.includes('firefox')) return 'firefox';
  if (ua.includes('safari'))  return 'safari';
  return 'other';
}

function parseOS(ua = '') {
  ua = ua.toLowerCase();
  if (ua.includes('iphone') || ua.includes('ipad')) return 'ios';
  if (ua.includes('android'))  return 'android';
  if (ua.includes('windows'))  return 'windows';
  if (ua.includes('mac'))      return 'macos';
  if (ua.includes('linux'))    return 'linux';
  return 'other';
}

function isValidText(val, max = 500) {
  return typeof val === 'string' && val.trim().length > 0 && val.length <= max;
}

const VALID_EVENTS = new Set([
  'page_view', 'course_card_click', 'modal_open', 'modal_close',
  'form_start', 'form_submit', 'page_exit',
]);

const VALID_PROFESSIONS = new Set([
  'it-dev', 'data', 'design', 'marketing',
  'business', 'finance', 'languages', 'religion', 'exam-prep', 'other',
]);

const VALID_EXPERIENCE = new Set(['less-1', '1-3', '3-5', '5-plus']);


// ============================================================
// ROUTES — BILIMTAP (original, unchanged)
// ============================================================

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ── POST /session ────────────────────────────────────────────
app.post('/session', async (req, res) => {
  const {
    session_id, visitor_id, utm_source, utm_medium, utm_campaign,
    utm_content, utm_term, referrer, landing_url, screen_width, language, is_bot,
  } = req.body;

  if (!isValidText(session_id, 100) || !isValidText(visitor_id, 100)) {
    return res.status(400).json({ error: 'session_id and visitor_id are required' });
  }

  const ua = req.headers['user-agent'] || '';

  const { error } = await supabase
    .from('bilimtap_sessions')
    .upsert({
      session_id:   session_id.trim(),
      visitor_id:   visitor_id.trim(),
      utm_source:   utm_source   || null,
      utm_medium:   utm_medium   || null,
      utm_campaign: utm_campaign || null,
      utm_content:  utm_content  || null,
      utm_term:     utm_term     || null,
      referrer:     referrer     || null,
      landing_url:  landing_url  || null,
      device_type:  parseDevice(ua),
      browser:      parseBrowser(ua),
      os:           parseOS(ua),
      screen_width: Number.isInteger(screen_width) ? screen_width : null,
      language:     language     || null,
      is_bot:       is_bot === true,
    }, { onConflict: 'session_id' });

  if (error) {
    console.error('[/session] Supabase error:', error.message);
    return res.status(500).json({ error: 'Failed to create session' });
  }
  res.json({ ok: true });
});

// ── POST /event ──────────────────────────────────────────────
app.post('/event', async (req, res) => {
  const { session_id, visitor_id, event_type, course_id, metadata, time_on_page_ms } = req.body;

  if (!isValidText(session_id, 100) || !isValidText(visitor_id, 100)) {
    return res.status(400).json({ error: 'session_id and visitor_id are required' });
  }
  if (!VALID_EVENTS.has(event_type)) {
    return res.status(400).json({ error: `Invalid event_type: ${event_type}` });
  }

  const safeMeta = (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) ? metadata : null;

  const { error: eventError } = await supabase
    .from('bilimtap_events')
    .insert({
      session_id:      session_id.trim(),
      visitor_id:      visitor_id.trim(),
      event_type,
      course_id:       isValidText(course_id, 100) ? course_id.trim() : null,
      metadata:        safeMeta,
      time_on_page_ms: Number.isInteger(time_on_page_ms) ? time_on_page_ms : null,
    });

  if (eventError) {
    console.error('[/event] insert error:', eventError.message);
    return res.status(500).json({ error: 'Failed to record event' });
  }

  const sessionUpdates = {};
  if (event_type === 'course_card_click') sessionUpdates.did_click_card  = true;
  if (event_type === 'modal_open')        sessionUpdates.did_open_modal  = true;
  if (event_type === 'form_start')        sessionUpdates.did_start_form  = true;
  if (event_type === 'form_submit')       sessionUpdates.did_submit_form = true;

  if (Object.keys(sessionUpdates).length > 0) {
    sessionUpdates.last_seen_at = new Date().toISOString();
    await supabase.from('bilimtap_sessions').update(sessionUpdates).eq('session_id', session_id.trim());
  }

  res.json({ ok: true });
});

// ── POST /submit ─────────────────────────────────────────────
app.post('/submit', async (req, res) => {
  const { session_id, visitor_id, phone, email, name, course_id, time_on_page_ms } = req.body;

  if (!isValidText(session_id, 100) || !isValidText(visitor_id, 100)) {
    return res.status(400).json({ error: 'session_id and visitor_id are required' });
  }
  if (!isValidText(course_id, 100)) {
    return res.status(400).json({ error: 'course_id is required' });
  }

  const hasPhone = isValidText(phone, 30);
  const hasEmail = isValidText(email, 200);
  if (!hasPhone && !hasEmail) {
    return res.status(400).json({ error: 'phone or email is required' });
  }

  const { data: existing } = await supabase
    .from('bilimtap_submissions').select('id').eq('visitor_id', visitor_id.trim()).limit(1);
  const is_duplicate = Array.isArray(existing) && existing.length > 0;

  const { error } = await supabase.from('bilimtap_submissions').insert({
    session_id:  session_id.trim(),
    visitor_id:  visitor_id.trim(),
    phone:       hasPhone ? phone.trim() : null,
    email:       hasEmail ? email.trim().toLowerCase() : null,
    name:        isValidText(name, 200) ? name.trim() : null,
    course_id:   course_id.trim(),
    is_duplicate,
  });

  if (error) {
    console.error('[/submit] Supabase error:', error.message);
    return res.status(500).json({ error: 'Failed to save lead' });
  }

  res.json({ ok: true });
});

// ── POST /tutor ───────────────────────────────────────────────
app.post('/tutor', async (req, res) => {
  const { name, phone, email, profession, experience_years, course_idea, about } = req.body;

  if (!isValidText(name, 200))         return res.status(400).json({ error: 'name is required' });
  if (!isValidText(phone, 30))         return res.status(400).json({ error: 'phone is required' });
  if (!VALID_PROFESSIONS.has(profession))  return res.status(400).json({ error: 'Invalid profession value' });
  if (!VALID_EXPERIENCE.has(experience_years)) return res.status(400).json({ error: 'Invalid experience_years value' });
  if (!isValidText(course_idea, 500))  return res.status(400).json({ error: 'course_idea is required' });
  if (!isValidText(about, 2000))       return res.status(400).json({ error: 'about is required' });

  const { error } = await supabase.from('bilimtap_tutor_applications').insert({
    name:             name.trim(),
    phone:            phone.trim(),
    email:            isValidText(email, 200) ? email.trim().toLowerCase() : null,
    profession,
    experience_years,
    course_idea:      course_idea.trim(),
    about:            about.trim(),
    status:           'new',
  });

  if (error) {
    console.error('[/tutor] insert error:', error.message);
    return res.status(500).json({ error: 'Failed to save tutor application' });
  }

  res.json({ ok: true });
});


// ============================================================
// ============================================================
//
//   IELTS PREP PLATFORM — Endpoints
//
// ============================================================
// ============================================================

// ── HELPERS — IELTS ─────────────────────────────────────────

function parseBlock(raw) {
  const b = parseInt(raw, 10);
  return (b >= 1 && b <= 3) ? b : null;
}

function parseDay(raw) {
  const d = parseInt(raw, 10);
  return (Number.isFinite(d) && d >= 1) ? d : null;
}

const BLOCK_TABLES = {
  1: 'block1_questions',
  2: 'block2_questions',
  3: 'block3_questions',
};

// ─────────────────────────────────────────────────────────────
// IELTS SCORING SYSTEM PROMPT
//
// FIX: The prompt now:
//   1. Explicitly instructs GPT to use the provided question
//      text when evaluating relevance and coherence.
//   2. Defines what constitutes incoherent / off-topic speech
//      and mandates low scores for such responses.
//   3. Anchors all band descriptors to the official IELTS scale
//      so GPT cannot award inflated scores for poor speech.
//   4. Requires the examiner_note to state when speech was
//      incoherent or not addressing the question.
// ─────────────────────────────────────────────────────────────
const IELTS_SCORING_SYSTEM = `You are a strict, certified IELTS speaking examiner. Your task is to evaluate a candidate's spoken response that has been transcribed to text.

You will be given:
  1. The IELTS question the candidate was supposed to answer.
  2. A transcript of what the candidate actually said.

Evaluation rules — follow these exactly:
- Base your scores strictly on the official IELTS Band Descriptors (0–9 scale, half-band increments allowed).
- Score 0 if the transcript is empty, entirely unintelligible, or contains no recognisable English words.
- Score 1–2 for responses that consist of random sounds, gibberish, or words with no coherent meaning.
- Score 3–4 for responses that contain real English words but are largely incoherent, repetitive, or completely off-topic.
- Only award Band 5 or above if the response directly addresses the question with recognisable structure and vocabulary.
- Never inflate scores. A Band 7 requires fluent, well-organised speech with precise vocabulary. Apply this standard rigorously.
- Relevance matters: if the candidate did not address the question at all, this must reduce Fluency & Coherence significantly.
- Pronunciation is inferred from spelling irregularities, non-standard word usage, and structural errors visible in the transcript.

Return ONLY valid JSON in exactly this shape — no text before or after:
{
  "overall_band": 0.0,
  "fluency_coherence": 0.0,
  "lexical_resource": 0.0,
  "grammatical_range": 0.0,
  "pronunciation": 0.0,
  "strengths": "Describe any genuine strengths. If there are none, write: No clear strengths identified.",
  "improvements": "Specific, actionable areas to improve.",
  "examiner_note": "One honest sentence summarising the response. State clearly if speech was incoherent or off-topic."
}`;

// ── GET /api/questions ───────────────────────────────────────
app.get('/api/questions', async (req, res) => {
  const day   = parseDay(req.query.day);
  const block = parseBlock(req.query.block);

  if (!day || !block) {
    return res.status(400).json({
      error: 'day (integer ≥ 1) and block (1, 2, or 3) are required query params',
    });
  }

  const { data, error } = await supabase
    .from(BLOCK_TABLES[block])
    .select('*')
    .eq('day', day)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return res.status(404).json({ day_content: null });
    console.error('[GET /api/questions]', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  return res.status(200).json({ day_content: data });
});


// ── POST /api/answers ────────────────────────────────────────
app.post('/api/answers', async (req, res) => {
  const { session_id, day, block, question_field, question_type, answer_text, time_spent_ms } = req.body;

  if (!isValidText(session_id, 200)) return res.status(400).json({ error: 'session_id is required' });

  const parsedDay   = parseDay(day);
  const parsedBlock = parseBlock(block);
  if (!parsedDay || !parsedBlock) return res.status(400).json({ error: 'day (integer ≥ 1) and block (1–3) are required' });

  if (!isValidText(question_field, 100)) return res.status(400).json({ error: 'question_field is required' });

  const { error } = await supabase.from('answers').insert({
    session_id:     session_id.trim(),
    day:            parsedDay,
    block:          parsedBlock,
    question_field: question_field.trim(),
    question_type:  isValidText(question_type, 200) ? question_type.trim() : null,
    answer_text:    typeof answer_text === 'string' ? answer_text : '',
    time_spent_ms:  Number.isInteger(time_spent_ms) ? time_spent_ms : null,
  });

  if (error) {
    console.error('[POST /api/answers]', error.message);
    return res.status(500).json({ error: 'Failed to save answer' });
  }

  return res.status(201).json({ ok: true });
});


// ── POST /api/sessions ───────────────────────────────────────
app.post('/api/sessions', async (req, res) => {
  const { session_id, started_at, device_info } = req.body;

  if (!isValidText(session_id, 200)) return res.status(400).json({ error: 'session_id is required' });

  const safeDeviceInfo = (device_info && typeof device_info === 'object') ? {
    userAgent: device_info.userAgent || null,
    language:  device_info.language  || null,
    screenW:   device_info.screenW   || null,
    screenH:   device_info.screenH   || null,
    timezone:  device_info.timezone  || null,
    referrer:  device_info.referrer  || null,
  } : null;

  const { error } = await supabase
    .from('sessions')
    .upsert(
      { session_id: session_id.trim(), started_at: started_at || new Date().toISOString(), device_info: safeDeviceInfo },
      { onConflict: 'session_id', ignoreDuplicates: true }
    );

  if (error) console.error('[POST /api/sessions]', error.message);
  // Always 201 — a failed session must never block the user
  return res.status(201).json({ ok: true });
});


// ── POST /api/events ─────────────────────────────────────────
app.post('/api/events', async (req, res) => {
  const { session_id, event_name, time_in_session_ms, data } = req.body;

  if (!isValidText(session_id, 200)) return res.status(400).json({ error: 'session_id is required' });
  if (!isValidText(event_name, 100)) return res.status(400).json({ error: 'event_name is required' });

  const safeData = (data && typeof data === 'object' && !Array.isArray(data)) ? data : null;

  const { error } = await supabase.from('events').insert({
    session_id:         session_id.trim(),
    event_name:         event_name.trim(),
    time_in_session_ms: Number.isInteger(time_in_session_ms) ? time_in_session_ms : null,
    data:               safeData,
  });

  if (error) console.error('[POST /api/events]', error.message);
  return res.status(201).json({ ok: true });
});


// ── POST /api/speaking/submit ────────────────────────────────
//
// Pipeline:
//   1. Validate multipart fields
//   2. Upload raw audio to Supabase Storage
//   3. Transcribe via OpenAI Whisper
//   4. Score via GPT-4o — using both the question text and the
//      transcript so evaluation is contextually accurate
//   5. Persist everything to speaking_submissions
//   6. Return { ok, transcript, scores, storage_path }
//
// Form fields (multipart):
//   audio            — audio blob           (required)
//   session_id       — string               (required)
//   day              — integer              (required)
//   question_field   — string               (required)
//   question_type    — string               (optional)
//   question_content — string               (optional) — the actual exam question text
//   prep_time_ms     — integer              (optional)
//   retry_count      — integer              (optional)
//
app.post('/api/speaking/submit', upload.single('audio'), async (req, res) => {

  // ── 1. Validate ──────────────────────────────────────────
  if (!req.file) return res.status(400).json({ error: 'audio file is required' });

  const {
    session_id,
    day,
    question_field,
    question_type,
    question_content,  // FIX: the actual exam question text
    prep_time_ms,
    retry_count,
  } = req.body;

  if (!isValidText(session_id, 200))     return res.status(400).json({ error: 'session_id is required' });
  const parsedDay = parseDay(day);
  if (!parsedDay)                        return res.status(400).json({ error: 'day (integer ≥ 1) is required' });
  if (!isValidText(question_field, 100)) return res.status(400).json({ error: 'question_field is required' });

  const audioBuffer = req.file.buffer;
  const mimeType    = req.file.mimetype;

  const EXT_MAP = {
    'audio/webm': 'webm', 'video/webm': 'webm',
    'audio/ogg':  'ogg',  'audio/wav':  'wav',
    'audio/mpeg': 'mp3',  'audio/mp4':  'm4a',
    'audio/x-m4a':'m4a',  'audio/flac': 'flac',
  };
  const ext = EXT_MAP[mimeType] || 'webm';

  // ── 2. Upload to Supabase Storage ───────────────────────
  const storagePath = `day${parsedDay}/${question_field.trim()}/${session_id.trim()}_${Date.now()}.${ext}`;

  const { error: storageError } = await supabase.storage
    .from('speaking-recordings')
    .upload(storagePath, audioBuffer, { contentType: mimeType, upsert: false, cacheControl: '3600' });

  if (storageError) {
    console.error('[/api/speaking/submit] Storage error:', storageError.message);
    return res.status(500).json({ error: 'Failed to upload audio' });
  }

  // ── 3. Transcribe with Whisper ──────────────────────────
  let transcript = '';
  try {
    const audioFile = new File([audioBuffer], `recording.${ext}`, { type: mimeType });
    const result = await openaiWhisper.audio.transcriptions.create({
      model:           'whisper-1',
      file:            audioFile,
      language:        'en',
      response_format: 'text',
    });
    transcript = (typeof result === 'string' ? result : result.text || '').trim();
  } catch (whisperErr) {
    console.error('[/api/speaking/submit] Whisper error:', whisperErr.message);
    // Non-fatal — continue with empty transcript
  }

  // ── 4. Score with GPT-4o ────────────────────────────────
  // FIX: Build a user message that includes:
  //   a) the actual exam question the student was answering
  //   b) the transcribed speech
  // This gives GPT the context it needs to judge relevance,
  // coherence, and band score accurately.
  let scores = null;
  try {
    // Determine what to show as the question context
    const questionLabel   = (question_type   || question_field || '').trim();
    const questionText    = (question_content || '').trim();
    const transcriptText  = transcript || '[no speech detected]';

    const userMessage = [
      `IELTS Speaking Task: ${questionLabel}`,
      questionText ? `\nQuestion / Cue Card:\n${questionText}` : '',
      `\nCandidate's Transcript:\n${transcriptText}`,
    ].join('');

    const completion = await openaiGpt.chat.completions.create({
      model:       'gpt-4o',
      temperature: 0.1,   // low temperature for consistent, strict scoring
      max_tokens:  600,
      messages: [
        { role: 'system', content: IELTS_SCORING_SYSTEM },
        { role: 'user',   content: userMessage },
      ],
    });

    const raw = (completion.choices[0]?.message?.content || '').trim();

    // Strip any accidental markdown code fences before parsing
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    scores = JSON.parse(cleaned);

    // Sanity-check: ensure all required keys exist and values are numeric
    const requiredKeys = ['overall_band', 'fluency_coherence', 'lexical_resource', 'grammatical_range', 'pronunciation'];
    for (const k of requiredKeys) {
      if (typeof scores[k] !== 'number') {
        scores[k] = null;
      }
    }

  } catch (gptErr) {
    console.error('[/api/speaking/submit] GPT scoring error:', gptErr.message);
    // Non-fatal — scores remain null; frontend shows success without scores
  }

  // ── 5. Persist to speaking_submissions ──────────────────
  const { error: dbError } = await supabase.from('speaking_submissions').insert({
    session_id:       session_id.trim(),
    day:              parsedDay,
    question_field:   question_field.trim(),
    question_type:    isValidText(question_type, 200)    ? question_type.trim()    : null,
    question_content: isValidText(question_content, 5000) ? question_content.trim() : null,
    storage_path:     storagePath,
    transcript:       transcript  || null,
    scores:           scores      || null,
    prep_time_ms:     Number.isFinite(Number(prep_time_ms))  ? Number(prep_time_ms)  : null,
    retry_count:      Number.isFinite(Number(retry_count))   ? Number(retry_count)   : null,
  });

  if (dbError) {
    console.error('[/api/speaking/submit] DB insert error:', dbError.message);
    // Audio is already stored — return partial success
    return res.status(207).json({
      ok:           false,
      warning:      'Audio stored but DB record failed',
      storage_path: storagePath,
      transcript,
      scores,
    });
  }

  return res.status(201).json({ ok: true, storage_path: storagePath, transcript, scores });
});


// ── Multer error handler ─────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError || err.message?.startsWith('Unsupported audio')) {
    return res.status(400).json({ error: err.message });
  }
  console.error('[Unhandled error]', err);
  res.status(500).json({ error: 'Internal server error' });
});


// ============================================================
// 404 CATCH-ALL  (keep at the very bottom)
// ============================================================
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});


// ─── START ───────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log(`[Server] Accepting requests from: ${ALLOWED_ORIGIN}`);
});