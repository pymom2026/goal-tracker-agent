// ─────────────────────────────────────────────────────────────────
// Goal Tracker Agent — Railway Backend
// Runs nightly at 9pm, checks Google Calendar, detects conflicts,
// calls Claude for suggestions, sends Web Push to phone
// ─────────────────────────────────────────────────────────────────

import express from 'express';
import webpush from 'web-push';
import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';
import cron from 'node-cron';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

// ── Config ────────────────────────────────────────────────────────
const PORT            = process.env.PORT || 3000;
const VAPID_PUBLIC    = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE   = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL     = process.env.VAPID_EMAIL;        // mailto:you@gmail.com
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const GCAL_TOKEN      = process.env.GCAL_REFRESH_TOKEN; // long-lived refresh token
const GCAL_CLIENT_ID  = process.env.GCAL_CLIENT_ID;
const GCAL_CLIENT_SEC = process.env.GCAL_CLIENT_SECRET;
const CRON_TIMEZONE   = process.env.TIMEZONE || 'America/Los_Angeles';

// ── Web Push setup (lazy — only init when vars present) ──────────
function initVapid() {
  if (!VAPID_EMAIL || !VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.warn('VAPID env vars missing — push notifications disabled');
    return false;
  }
  try {
    webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
    console.log('VAPID initialized OK');
    return true;
  } catch(e) {
    console.error('VAPID init failed:', e.message);
    return false;
  }
}
const vapidReady = initVapid();

// ── Subscription store (in-memory + persisted to file) ────────────
const SUBS_FILE = path.join(__dirname, 'subscriptions.json');
let subscriptions = [];

function loadSubscriptions() {
  try {
    if (fs.existsSync(SUBS_FILE)) {
      subscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
      console.log(`Loaded ${subscriptions.length} push subscription(s)`);
    }
  } catch(e) { console.error('Could not load subscriptions:', e); }
}

function saveSubscriptions() {
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions, null, 2)); }
  catch(e) { console.error('Could not save subscriptions:', e); }
}

loadSubscriptions();

// ── Schedule config ───────────────────────────────────────────────
const EXERCISE_WINDOWS = {
  Monday:    [{ start: '11:00', end: '12:30', type: 'Functional Training' }],
  Tuesday:   [{ start: '11:00', end: '12:30', type: 'Pilates' }],
  Wednesday: [],
  Thursday:  [{ start: '11:00', end: '12:30', type: 'Yoga – Core & Abs' }],
  Friday:    [{ start: '11:00', end: '12:30', type: 'Functional Training + Core' }],
  Saturday:  [{ start: '06:00', end: '07:00', type: 'Pilates + Yoga Flow' }],
  Sunday:    [{ start: '06:00', end: '07:00', type: 'Active Recovery Walk' }],
};

const STUDY_WINDOWS = {
  Monday:    [{ start: '08:30', end: '11:00' }, { start: '13:30', end: '15:00' }],
  Tuesday:   [{ start: '08:30', end: '11:00' }, { start: '13:30', end: '15:00' }],
  Wednesday: [{ start: '08:30', end: '11:00' }],
  Thursday:  [{ start: '08:30', end: '11:00' }, { start: '13:30', end: '15:00' }],
  Friday:    [{ start: '08:30', end: '11:00' }, { start: '13:30', end: '15:00' }],
  Saturday:  [{ start: '09:00', end: '11:00' }],
  Sunday:    [{ start: '09:00', end: '10:00' }],
};

// ── Google Calendar client ────────────────────────────────────────
function getCalendarClient() {
  const oauth2 = new google.auth.OAuth2(
    GCAL_CLIENT_ID,
    GCAL_CLIENT_SEC,
    'urn:ietf:wg:oauth:2.0:oob'
  );
  oauth2.setCredentials({ refresh_token: GCAL_TOKEN });
  return google.calendar({ version: 'v3', auth: oauth2 });
}

async function fetchTomorrowEvents() {
  const cal = getCalendarClient();
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);

  const start = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 0, 0, 0);
  const end   = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 23, 59, 59);

  const res = await cal.events.list({
    calendarId: 'primary',
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 20
  });

  return { events: res.data.items || [], date: tomorrow };
}

// ── Conflict detection ────────────────────────────────────────────
function toMins(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function getEventMins(event) {
  const startStr = event.start?.dateTime;
  if (!startStr) return null; // all-day event
  const d = new Date(startStr);
  return {
    start: d.getHours() * 60 + d.getMinutes(),
    end: d.getHours() * 60 + d.getMinutes() + Math.round((new Date(event.end.dateTime) - d) / 60000),
    title: event.summary || 'Appointment'
  };
}

function overlaps(evMins, windowStart, windowEnd, minMins=5) {
  const ws = toMins(windowStart);
  const we = toMins(windowEnd);
  return Math.min(evMins.end, we) - Math.max(evMins.start, ws) >= minMins;
}

function detectConflicts(events, dayName) {
  const conflicts = [];
  const exerciseWindows = EXERCISE_WINDOWS[dayName] || [];
  const studyWindows    = STUDY_WINDOWS[dayName]    || [];

  for (const event of events) {
    const evMins = getEventMins(event);
    if (!evMins) continue; // skip all-day events

    for (const w of exerciseWindows) {
      if (overlaps(evMins, w.start, w.end)) {
        conflicts.push({ type: 'exercise', window: w, event: evMins, eventTitle: evMins.title });
      }
    }
    for (const w of studyWindows) {
      if (overlaps(evMins, w.start, w.end)) {
        conflicts.push({ type: 'study', window: w, event: evMins, eventTitle: evMins.title });
      }
    }
  }

  return conflicts;
}

// ── Claude suggestion ─────────────────────────────────────────────
async function getSuggestion(conflicts, dayName, allEvents) {
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

  const conflictDesc = conflicts.map(c =>
    `- "${c.eventTitle}" conflicts with ${c.type} window (${c.window.start}–${c.window.end})`
  ).join('\n');

  const eventList = allEvents
    .filter(e => e.start?.dateTime)
    .map(e => {
      const s = new Date(e.start.dateTime);
      const en = new Date(e.end.dateTime);
      return `  ${s.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}–${en.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}: ${e.summary}`;
    }).join('\n');

  const prompt = `You are a helpful scheduling assistant for a mom with 2 elementary school kids who is training for fitness goals and studying AI for a PM job search.

Tomorrow is ${dayName}. Here are her calendar events:
${eventList || '  (none)'}

Conflicts with her schedule:
${conflictDesc}

Her constraints:
- Kids school dropoff by 7:30am, pickup at 3pm (1pm on Wednesdays)
- Exercise window: typically 11am–12:30pm on weekdays
- Study blocks: typically 8:30–11am and 1:30–3pm on weekdays
- Meditation: 5:30–6:30am (do not schedule anything here)
- Evenings are family time (dinner, kids bedtime routine by 9pm)

Please give a short, friendly suggestion (2-3 sentences max) for how to reschedule the conflicting blocks tomorrow. Be specific with times. End with one emoji.`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }]
  });

  return message.content[0].text;
}

// ── Send push notifications ───────────────────────────────────────
async function sendPushToAll(payload) {
  if (!vapidReady) { console.warn('Push skipped — VAPID not initialized'); return; }
  const dead = [];
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
      console.log('Push sent to subscription');
    } catch(e) {
      console.error('Push failed:', e.statusCode, e.body);
      if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub);
    }
  }
  // Remove dead subscriptions
  if (dead.length) {
    subscriptions = subscriptions.filter(s => !dead.includes(s));
    saveSubscriptions();
  }
}

// ── Main agent job ────────────────────────────────────────────────
async function runAgentJob() {
  console.log('🤖 Agent running:', new Date().toISOString());

  if (subscriptions.length === 0) {
    console.log('No push subscriptions — skipping');
    return;
  }

  try {
    const { events, date } = await fetchTomorrowEvents();
    const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
    console.log(`Checking ${dayName} — ${events.length} events`);

    const conflicts = detectConflicts(events, dayName);
    console.log(`Conflicts found: ${conflicts.length}`);

    if (conflicts.length === 0) {
      // Send a clean day notification
      await sendPushToAll({
        title: `Tomorrow looks clear ✅`,
        body: `${dayName} schedule is conflict-free. Exercise and study blocks are protected.`,
        url: '/',
        tag: 'daily-check'
      });
      return;
    }

    // Get Claude suggestion
    const suggestion = await getSuggestion(conflicts, dayName, events);
    console.log('Claude suggestion:', suggestion);

    const conflictNames = [...new Set(conflicts.map(c => c.eventTitle))].join(', ');
    const types = [...new Set(conflicts.map(c => c.type))].join(' & ');

    await sendPushToAll({
      title: `Schedule conflict tomorrow ⚠️`,
      body: `"${conflictNames}" overlaps your ${types} block. Tap to see Claude's suggestion.`,
      suggestion,
      conflictCount: conflicts.length,
      dayName,
      url: '/?agent=1',
      tag: 'conflict-alert'
    });

  } catch(e) {
    console.error('Agent job failed:', e);
  }
}

// ── Cron: 9pm nightly ─────────────────────────────────────────────
cron.schedule('0 21 * * *', runAgentJob, { timezone: CRON_TIMEZONE });
console.log(`Cron scheduled for 9pm ${CRON_TIMEZONE}`);

// ── API Routes ────────────────────────────────────────────────────

// Frontend registers push subscription here
app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });

  // Avoid duplicates
  const exists = subscriptions.some(s => s.endpoint === sub.endpoint);
  if (!exists) {
    subscriptions.push(sub);
    saveSubscriptions();
    console.log('New push subscription registered. Total:', subscriptions.length);
  }
  res.json({ ok: true, total: subscriptions.length });
});

// Frontend unregisters push subscription
app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
  saveSubscriptions();
  res.json({ ok: true });
});

// Return VAPID public key to frontend (needed to create subscription)
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC });
});

// Manual trigger for testing (GET /api/run-agent)
app.get('/api/run-agent', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== process.env.AGENT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ ok: true, message: 'Agent job triggered' });
  await runAgentJob(); // run after responding
});

// ── Apple Health workout ingestion ───────────────────────────────
// Called by iOS Shortcut after each workout
// Body: { secret, date, workoutType, durationMins, calories, heartRateAvg, source }
// Stores workouts keyed by date in workouts.json on Railway disk

const WORKOUTS_FILE = path.join(__dirname, 'workouts.json');
let workoutsStore = {};

function loadWorkouts() {
  try {
    if (fs.existsSync(WORKOUTS_FILE)) {
      workoutsStore = JSON.parse(fs.readFileSync(WORKOUTS_FILE, 'utf8'));
      console.log(`Loaded workouts for ${Object.keys(workoutsStore).length} day(s)`);
    }
  } catch(e) { console.error('Could not load workouts:', e); }
}

function saveWorkoutsStore() {
  try { fs.writeFileSync(WORKOUTS_FILE, JSON.stringify(workoutsStore, null, 2)); }
  catch(e) { console.error('Could not save workouts:', e); }
}

loadWorkouts();

// POST /api/workout  — iOS Shortcut calls this after each workout
app.post('/api/workout', (req, res) => {
  const { secret, date, workoutType, durationMins, calories, heartRateAvg, source } = req.body;

  if (secret !== process.env.AGENT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Validate date  format YYYY-MM-DD
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  if (!workoutType) {
    return res.status(400).json({ error: 'workoutType is required' });
  }

  const entry = {
    workoutType: String(workoutType),
    durationMins: durationMins ? Number(durationMins) : null,
    calories: calories ? Math.round(Number(calories)) : null,
    heartRateAvg: heartRateAvg ? Math.round(Number(heartRateAvg)) : null,
    source: source || 'Apple Health',
    loggedAt: new Date().toISOString()
  };

  if (!workoutsStore[date]) workoutsStore[date] = [];
  // Deduplicate: replace if same workoutType already logged for this date
  const idx = workoutsStore[date].findIndex(w => w.workoutType === entry.workoutType);
  if (idx >= 0) workoutsStore[date][idx] = entry;
  else workoutsStore[date].push(entry);

  saveWorkoutsStore();
  console.log(`Workout logged for ${date}:`, entry);

  res.json({ ok: true, date, entry });
});

// GET /api/workouts?secret=X&from=YYYY-MM-DD&to=YYYY-MM-DD
// Tracker polls this to pull in real workout data
app.get('/api/workouts', (req, res) => {
  if (req.query.secret !== process.env.AGENT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { from, to } = req.query;
  let result = workoutsStore;

  if (from || to) {
    result = {};
    for (const [date, entries] of Object.entries(workoutsStore)) {
      if (from && date < from) continue;
      if (to   && date > to  ) continue;
      result[date] = entries;
    }
  }

  res.json({ ok: true, workouts: result });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', subs: subscriptions.length, workoutDays: Object.keys(workoutsStore).length }));

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Agent server running on port ${PORT}`);
});
