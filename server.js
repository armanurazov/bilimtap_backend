'use strict';

// ============================================================
// BILIMTAP — Backend Server
// Single-file Express server
//
// Contains two feature sets:
//   1. BilimTap Validation Campaign  (original)
//   2. IELTS Prep Platform           (added below, clearly separated)
//
// Shared Supabase project & environment variables.
//
// Setup:
//   npm install express @supabase/supabase-js cors helmet
//
// Required environment variables (set in Railway dashboard):
//   SUPABASE_URL      — from Supabase project settings
//   SUPABASE_KEY      — service_role key (not anon key)
//   ALLOWED_ORIGIN    — your frontend URL e.g. https://bilimtap.vercel.app
//   PORT              — Railway sets this automatically
// ============================================================

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// ─── ENV VALIDATION ─────────────────────────────────────────
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_KEY', 'ALLOWED_ORIGIN'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`[FATAL] Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const {
  SUPABASE_URL,
  SUPABASE_KEY,
  ALLOWED_ORIGIN,
  PORT = 3000,
} = process.env;

// ─── SUPABASE CLIENT ────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── EXPRESS SETUP ──────────────────────────────────────────
const app = express();

app.use(helmet());

app.use(cors({
  origin: true,
  methods: ['POST', 'GET'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json({ limit: '16kb' }));


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
  'page_view',
  'course_card_click',
  'modal_open',
  'modal_close',
  'form_start',
  'form_submit',
  'page_exit',
]);

const VALID_PROFESSIONS = new Set([
  'it-dev', 'data', 'design', 'marketing',
  'business', 'finance', 'languages', 'religion', 'exam-prep', 'other',
]);

const VALID_EXPERIENCE = new Set(['less-1', '1-3', '3-5', '5-plus']);


// ============================================================
// ROUTES — BILIMTAP (original, unchanged)
// ============================================================

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ── POST /session ────────────────────────────────────────────
app.post('/session', async (req, res) => {
  const {
    session_id,
    visitor_id,
    utm_source,
    utm_medium,
    utm_campaign,
    utm_content,
    utm_term,
    referrer,
    landing_url,
    screen_width,
    language,
    is_bot,
  } = req.body;

  if (!isValidText(session_id, 100) || !isValidText(visitor_id, 100)) {
    return res.status(400).json({ error: 'session_id and visitor_id are required' });
  }

  const ua          = req.headers['user-agent'] || '';
  const device_type = parseDevice(ua);
  const browser     = parseBrowser(ua);
  const os          = parseOS(ua);

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
      device_type,
      browser,
      os,
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
  const {
    session_id,
    visitor_id,
    event_type,
    course_id,
    metadata,
    time_on_page_ms,
  } = req.body;

  if (!isValidText(session_id, 100) || !isValidText(visitor_id, 100)) {
    return res.status(400).json({ error: 'session_id and visitor_id are required' });
  }

  if (!VALID_EVENTS.has(event_type)) {
    return res.status(400).json({ error: `Invalid event_type: ${event_type}` });
  }

  const safeMeta = (metadata && typeof metadata === 'object' && !Array.isArray(metadata))
    ? metadata
    : null;

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
    console.error('[/event] Supabase insert error:', eventError.message);
    return res.status(500).json({ error: 'Failed to record event' });
  }

  const sessionUpdates = {};
  if (event_type === 'course_card_click') sessionUpdates.did_click_card  = true;
  if (event_type === 'modal_open')        sessionUpdates.did_open_modal  = true;
  if (event_type === 'form_start')        sessionUpdates.did_start_form  = true;
  if (event_type === 'form_submit')       sessionUpdates.did_submit_form = true;

  if (Object.keys(sessionUpdates).length > 0) {
    sessionUpdates.last_seen_at = new Date().toISOString();
    const { error: sessionError } = await supabase
      .from('bilimtap_sessions')
      .update(sessionUpdates)
      .eq('session_id', session_id.trim());

    if (sessionError) {
      console.warn('[/event] Session update warning:', sessionError.message);
    }
  }

  res.json({ ok: true });
});

// ── POST /submit ─────────────────────────────────────────────
app.post('/submit', async (req, res) => {
  const {
    session_id,
    visitor_id,
    phone,
    email,
    name,
    course_id,
    time_on_page_ms,
  } = req.body;

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
    .from('bilimtap_submissions')
    .select('id')
    .eq('visitor_id', visitor_id.trim())
    .limit(1);

  const is_duplicate = Array.isArray(existing) && existing.length > 0;

  const { error: submitError } = await supabase
    .from('bilimtap_submissions')
    .insert({
      session_id:  session_id.trim(),
      visitor_id:  visitor_id.trim(),
      phone:       hasPhone ? phone.trim() : null,
      email:       hasEmail ? email.trim().toLowerCase() : null,
      name:        isValidText(name, 200) ? name.trim() : null,
      course_id:   course_id.trim(),
      is_duplicate,
    });

  if (submitError) {
    console.error('[/submit] Supabase insert error:', submitError.message);
    return res.status(500).json({ error: 'Failed to save submission' });
  }

  await supabase
    .from('bilimtap_events')
    .insert({
      session_id:      session_id.trim(),
      visitor_id:      visitor_id.trim(),
      event_type:      'form_submit',
      course_id:       course_id.trim(),
      metadata:        { has_phone: hasPhone, has_email: hasEmail, is_duplicate },
      time_on_page_ms: Number.isInteger(time_on_page_ms) ? time_on_page_ms : null,
    });

  await supabase
    .from('bilimtap_sessions')
    .update({ did_submit_form: true, did_start_form: true, last_seen_at: new Date().toISOString() })
    .eq('session_id', session_id.trim());

  res.json({ ok: true, is_duplicate });
});

// ── POST /tutor ───────────────────────────────────────────────
app.post('/tutor', async (req, res) => {
  const {
    name,
    phone,
    email,
    profession,
    experience_years,
    course_idea,
    about,
  } = req.body;

  if (!isValidText(name, 200)) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!isValidText(phone, 30)) {
    return res.status(400).json({ error: 'phone is required' });
  }
  if (!VALID_PROFESSIONS.has(profession)) {
    return res.status(400).json({ error: 'Invalid profession value' });
  }
  if (!VALID_EXPERIENCE.has(experience_years)) {
    return res.status(400).json({ error: 'Invalid experience_years value' });
  }
  if (!isValidText(course_idea, 500)) {
    return res.status(400).json({ error: 'course_idea is required' });
  }
  if (!isValidText(about, 2000)) {
    return res.status(400).json({ error: 'about is required' });
  }

  const { error } = await supabase
    .from('bilimtap_tutor_applications')
    .insert({
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
    console.error('[/tutor] Supabase insert error:', error.message);
    return res.status(500).json({ error: 'Failed to save tutor application' });
  }

  res.json({ ok: true });
});


// ============================================================
// ============================================================
//
//   IELTS PREP PLATFORM — Endpoints
//   Tables used (all in the same Supabase project):
//     ielts_sessions        — one row per browser session
//     ielts_events          — one row per user interaction
//     block1_questions      — task content for Block 1, one row per day
//     block2_questions      — task content for Block 2, one row per day
//     block3_questions      — task content for Block 3, one row per day
//     answers               — all student answers across all blocks
//
//   All routes are prefixed with /api/ to avoid collisions
//   with the existing BilimTap routes above.
//
// ============================================================
// ============================================================

// ── HELPERS — IELTS ─────────────────────────────────────────

/**
 * Parses and validates the block query param.
 * Returns integer 1-3, or null if invalid.
 */
function parseBlock(raw) {
  const b = parseInt(raw, 10);
  return (b >= 1 && b <= 3) ? b : null;
}

/**
 * Parses and validates a positive integer day param.
 * Returns integer >= 1, or null if invalid.
 */
function parseDay(raw) {
  const d = parseInt(raw, 10);
  return (Number.isFinite(d) && d >= 1) ? d : null;
}

// Valid block table names — used as an allowlist to prevent
// any possibility of SQL injection via the block param.
const BLOCK_TABLES = {
  1: 'block1_questions',
  2: 'block2_questions',
  3: 'block3_questions',
};

// ── GET /api/questions ───────────────────────────────────────
//
// Fetches the task content row for a given day + block.
// The frontend reads whichever fields it needs from day_content.
//
// Query params:
//   day   (integer, required)  e.g. ?day=1
//   block (integer 1-3, req.)  e.g. &block=2
//
// Response 200: { day_content: { id, day, <question columns>... } }
// Response 400: { error: "..." }   — bad params
// Response 404: { day_content: null }  — no row for that day/block
// Response 500: { error: "Internal server error" }
//
app.get('/api/questions', async (req, res) => {
  const day   = parseDay(req.query.day);
  const block = parseBlock(req.query.block);

  if (!day || !block) {
    return res.status(400).json({
      error: 'day (integer ≥ 1) and block (1, 2, or 3) are required query params',
    });
  }

  const table = BLOCK_TABLES[block];

  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('day', day)
    .single();          // exactly one row per day

  if (error) {
    // PGRST116 = "no rows found" from PostgREST / Supabase
    if (error.code === 'PGRST116') {
      return res.status(404).json({ day_content: null });
    }
    console.error('[GET /api/questions]', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  return res.status(200).json({ day_content: data });
});


// ── POST /api/answers ────────────────────────────────────────
//
// Saves one student answer. Called on every Next / Finish click.
// answer_text may be empty string (records a skipped question).
//
// Body: {
//   session_id,     string  required
//   day,            integer required
//   block,          integer required  1-3
//   question_field, string  required  e.g. "natural_english_rewrite"
//   question_type,  string  optional  human-readable label
//   answer_text,    string  optional  what the student typed
//   time_spent_ms,  integer optional  ms on this question
// }
//
// Response 201: { ok: true }
// Response 400: { error: "..." }
// Response 500: { error: "..." }
//
app.post('/api/answers', async (req, res) => {
  const {
    session_id,
    day,
    block,
    question_field,
    question_type,
    answer_text,
    time_spent_ms,
  } = req.body;

  if (!isValidText(session_id, 200)) {
    return res.status(400).json({ error: 'session_id is required' });
  }

  const parsedDay   = parseDay(day);
  const parsedBlock = parseBlock(block);

  if (!parsedDay || !parsedBlock) {
    return res.status(400).json({ error: 'day (integer ≥ 1) and block (1–3) are required' });
  }

  if (!isValidText(question_field, 100)) {
    return res.status(400).json({ error: 'question_field is required' });
  }

  const { error } = await supabase
    .from('answers')
    .insert({
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
//
// Registers a new IELTS browser session when the app loads.
// Uses upsert so duplicate calls (e.g. React strict mode) are safe.
//
// Body: {
//   session_id,  string  required
//   started_at,  string  ISO timestamp
//   device_info, object  { userAgent, language, screenW, screenH, timezone, referrer }
// }
//
// Response 201: { ok: true }
// Response 400: { error: "..." }
// Response 500: { error: "..." }
//
app.post('/api/sessions', async (req, res) => {
  const { session_id, started_at, device_info } = req.body;

  if (!isValidText(session_id, 200)) {
    return res.status(400).json({ error: 'session_id is required' });
  }

  // Whitelist the fields we accept from device_info to keep the DB clean
  const safeDeviceInfo = (device_info && typeof device_info === 'object')
    ? {
        userAgent: device_info.userAgent  || null,
        language:  device_info.language   || null,
        screenW:   device_info.screenW    || null,
        screenH:   device_info.screenH    || null,
        timezone:  device_info.timezone   || null,
        referrer:  device_info.referrer   || null,
      }
    : null;

  const { error } = await supabase
    .from('ielts_sessions')
    .upsert(
      {
        session_id:  session_id.trim(),
        started_at:  started_at || new Date().toISOString(),
        device_info: safeDeviceInfo,
      },
      { onConflict: 'session_id', ignoreDuplicates: true }
    );

  if (error) {
    console.error('[POST /api/sessions]', error.message);
    return res.status(500).json({ error: 'Failed to save session' });
  }

  return res.status(201).json({ ok: true });
});


// ── POST /api/events ─────────────────────────────────────────
//
// Tracks every user interaction fired by Analytics.track().
// No strict allowlist on event_name — IELTS events are numerous
// and evolving, so we store freely and filter in reporting.
//
// Body: {
//   session_id,         string  required
//   event_name,         string  required  e.g. "next_question"
//   time_in_session_ms, integer optional  ms since session start
//   data,               object  optional  arbitrary event payload
// }
//
// Response 201: { ok: true }
// Response 400: { error: "..." }
// Response 500: { error: "..." }
//
app.post('/api/events', async (req, res) => {
  const { session_id, event_name, time_in_session_ms, data } = req.body;

  if (!isValidText(session_id, 200)) {
    return res.status(400).json({ error: 'session_id is required' });
  }

  if (!isValidText(event_name, 100)) {
    return res.status(400).json({ error: 'event_name is required' });
  }

  const safeData = (data && typeof data === 'object' && !Array.isArray(data))
    ? data
    : null;

  const { error } = await supabase
    .from('ielts_events')
    .insert({
      session_id:         session_id.trim(),
      event_name:         event_name.trim(),
      time_in_session_ms: Number.isInteger(time_in_session_ms) ? time_in_session_ms : null,
      data:               safeData,
    });

  if (error) {
    console.error('[POST /api/events]', error.message);
    return res.status(500).json({ error: 'Failed to save event' });
  }

  return res.status(201).json({ ok: true });
});


// ============================================================
// 404 CATCH-ALL  (keep at the very bottom, after all routes)
// ============================================================
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});


// ─── START ───────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log(`[Server] Accepting requests from: ${ALLOWED_ORIGIN}`);
});