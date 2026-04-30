'use strict';

// ============================================================
// BILIMTAP — Validation Campaign Backend
// Single-file Express server
// Receives events from frontend → writes to Supabase
// ============================================================
// Setup:
//   npm install express @supabase/supabase-js cors helmet
//
// Required environment variables (set in Railway dashboard):
//   SUPABASE_URL      — from Supabase project settings
//   SUPABASE_KEY      — service_role key (not anon key)
//   ALLOWED_ORIGIN    — your Vercel frontend URL e.g. https://bilimtap.vercel.app
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

app.use(express.json({ limit: '16kb' })); // generous but bounded

// ─── HELPERS ────────────────────────────────────────────────

// Detect device type from User-Agent string
function parseDevice(ua = '') {
  ua = ua.toLowerCase();
  if (/ipad|tablet|playbook|silk/.test(ua))           return 'tablet';
  if (/mobile|iphone|ipod|android|blackberry/.test(ua)) return 'mobile';
  return 'desktop';
}

// Extract browser name from User-Agent
function parseBrowser(ua = '') {
  ua = ua.toLowerCase();
  if (ua.includes('edg/'))     return 'edge';
  if (ua.includes('opr/'))     return 'opera';
  if (ua.includes('chrome'))   return 'chrome';
  if (ua.includes('firefox'))  return 'firefox';
  if (ua.includes('safari'))   return 'safari';
  return 'other';
}

// Extract OS from User-Agent
function parseOS(ua = '') {
  ua = ua.toLowerCase();
  if (ua.includes('iphone') || ua.includes('ipad')) return 'ios';
  if (ua.includes('android'))  return 'android';
  if (ua.includes('windows'))  return 'windows';
  if (ua.includes('mac'))      return 'macos';
  if (ua.includes('linux'))    return 'linux';
  return 'other';
}

// Validate that a string is non-empty and under a max length
function isValidText(val, max = 500) {
  return typeof val === 'string' && val.trim().length > 0 && val.length <= max;
}

// Valid event types — anything else is rejected
const VALID_EVENTS = new Set([
  'page_view',
  'course_card_click',
  'modal_open',
  'modal_close',
  'form_start',
  'form_submit',
  'page_exit',
]);

// ─── ROUTES ─────────────────────────────────────────────────

// Health check — Railway uses this to confirm server is up
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ── POST /session ───────────────────────────────────────────
// Called once on page_view.
// Creates the session row which all subsequent events reference.
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
    is_bot,         // true if honeypot field was filled by a bot
  } = req.body;

  // Required fields
  if (!isValidText(session_id, 100) || !isValidText(visitor_id, 100)) {
    return res.status(400).json({ error: 'session_id and visitor_id are required' });
  }

  const ua          = req.headers['user-agent'] || '';
  const device_type = parseDevice(ua);
  const browser     = parseBrowser(ua);
  const os          = parseOS(ua);

  const { error } = await supabase
    .from('bilimtap_sessions')
    .upsert({                          // upsert in case of duplicate page_view fires
      session_id:    session_id.trim(),
      visitor_id:    visitor_id.trim(),
      utm_source:    utm_source    || null,
      utm_medium:    utm_medium    || null,
      utm_campaign:  utm_campaign  || null,
      utm_content:   utm_content   || null,
      utm_term:      utm_term      || null,
      referrer:      referrer      || null,
      landing_url:   landing_url   || null,
      device_type,
      browser,
      os,
      screen_width:  Number.isInteger(screen_width) ? screen_width : null,
      language:      language      || null,
      is_bot:        is_bot === true,
    }, { onConflict: 'session_id' });

  if (error) {
    console.error('[/session] Supabase error:', error.message);
    return res.status(500).json({ error: 'Failed to create session' });
  }

  res.json({ ok: true });
});

// ── POST /event ─────────────────────────────────────────────
// Called for every user action throughout the session.
app.post('/event', async (req, res) => {
  const {
    session_id,
    visitor_id,
    event_type,
    course_id,
    metadata,
    time_on_page_ms,
  } = req.body;

  // Required fields
  if (!isValidText(session_id, 100) || !isValidText(visitor_id, 100)) {
    return res.status(400).json({ error: 'session_id and visitor_id are required' });
  }

  if (!VALID_EVENTS.has(event_type)) {
    return res.status(400).json({ error: `Invalid event_type: ${event_type}` });
  }

  // Validate metadata is a plain object if provided
  const safeMeta = (metadata && typeof metadata === 'object' && !Array.isArray(metadata))
    ? metadata
    : null;

  // Write event row
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

  // Update session summary booleans — best effort, don't fail the request if this errors
  const sessionUpdates = {};
  if (event_type === 'course_card_click') sessionUpdates.did_click_card   = true;
  if (event_type === 'modal_open')        sessionUpdates.did_open_modal    = true;
  if (event_type === 'form_start')        sessionUpdates.did_start_form    = true;
  if (event_type === 'form_submit')       sessionUpdates.did_submit_form   = true;

  if (Object.keys(sessionUpdates).length > 0) {
    sessionUpdates.last_seen_at = new Date().toISOString();
    const { error: sessionError } = await supabase
      .from('bilimtap_sessions')
      .update(sessionUpdates)
      .eq('session_id', session_id.trim());

    if (sessionError) {
      // Log but don't fail — event is already saved, this is secondary
      console.warn('[/event] Session update warning:', sessionError.message);
    }
  }

  res.json({ ok: true });
});

// ── POST /submit ─────────────────────────────────────────────
// Called when user submits the pre-registration form.
// Writes to bilimtap_submissions (clean leads table).
// Also fires a form_submit event automatically.
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

  // Required fields
  if (!isValidText(session_id, 100) || !isValidText(visitor_id, 100)) {
    return res.status(400).json({ error: 'session_id and visitor_id are required' });
  }

  if (!isValidText(course_id, 100)) {
    return res.status(400).json({ error: 'course_id is required' });
  }

  // Must have at least one contact method
  const hasPhone = isValidText(phone, 30);
  const hasEmail = isValidText(email, 200);
  if (!hasPhone && !hasEmail) {
    return res.status(400).json({ error: 'phone or email is required' });
  }

  // Check if this visitor already submitted — mark duplicate if so
  const { data: existing } = await supabase
    .from('bilimtap_submissions')
    .select('id')
    .eq('visitor_id', visitor_id.trim())
    .limit(1);

  const is_duplicate = Array.isArray(existing) && existing.length > 0;

  // Write to clean leads table
  const { error: submitError } = await supabase
    .from('bilimtap_submissions')
    .insert({
      session_id:   session_id.trim(),
      visitor_id:   visitor_id.trim(),
      phone:        hasPhone ? phone.trim() : null,
      email:        hasEmail ? email.trim().toLowerCase() : null,
      name:         isValidText(name, 200) ? name.trim() : null,
      course_id:    course_id.trim(),
      is_duplicate,
    });

  if (submitError) {
    console.error('[/submit] Supabase insert error:', submitError.message);
    return res.status(500).json({ error: 'Failed to save submission' });
  }

  // Also log as event so funnel is complete in bilimtap_events
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

  // Update session summary
  await supabase
    .from('bilimtap_sessions')
    .update({ did_submit_form: true, did_start_form: true, last_seen_at: new Date().toISOString() })
    .eq('session_id', session_id.trim());

  res.json({ ok: true, is_duplicate });
});

// ─── 404 CATCH-ALL ───────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── START ───────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[BilimTap] Server running on port ${PORT}`);



  console.log(`[BilimTap] Accepting requests from: ${ALLOWED_ORIGIN}`);
});