// Handles /api/* only; every other path is served straight from public/ (see run_worker_first in wrangler.jsonc).
// /api/followup stores an opt-in for the accuracy follow-up: email, the calculator answers and the result shown.
// A daily cron (scheduled below) emails each person's check-ins when they fall due; /checkin is the page the
// email links to, and it talks to /api/checkin, /api/stop and /api/delete with the person's private token.

const CONSENT_VERSION = "2026-11-07";
const MAX_BODY = 8000;
const SITE = "https://willwelast.app";
const FROM = "Will We Last <checkin@willwelast.app>";
const REPLY_TO = "hello@willwelast.app";
const DAILY_LIMIT = 90; // Resend's free plan allows 100 emails a day
const REMIND_AFTER_DAYS = 14;

// Months after sign-up for each check-in. People who signed up under the first consent were promised two.
function scheduleFor(stage, consentVersion) {
  if (consentVersion === "2026-11-01") return [12, 36];
  return stage === "C" || stage === "D" ? [6, 12, 36, 60] : [12, 36, 60];
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function addMonths(iso, m) {
  const d = new Date(iso); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString();
}

async function ensureTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS followups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    email TEXT NOT NULL,
    stage TEXT NOT NULL,
    answers TEXT NOT NULL,
    result TEXT NOT NULL,
    consent_version TEXT NOT NULL
  )`).run();
  const cols = (await db.prepare("PRAGMA table_info(followups)").all()).results.map(r => r.name);
  if (!cols.includes("token")) await db.prepare("ALTER TABLE followups ADD COLUMN token TEXT").run();
  if (!cols.includes("stopped")) await db.prepare("ALTER TABLE followups ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0").run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    followup_id INTEGER NOT NULL,
    months INTEGER NOT NULL,
    due_at TEXT NOT NULL,
    sent_at TEXT,
    reminded_at TEXT,
    answered_at TEXT,
    answers TEXT
  )`).run();
}

// Give every sign-up a token and its check-ins (also covers people who joined before check-ins existed).
async function schedule(db) {
  const rows = (await db.prepare(`SELECT f.id, f.created_at, f.stage, f.consent_version, f.token FROM followups f
    WHERE f.token IS NULL OR NOT EXISTS (SELECT 1 FROM checkins c WHERE c.followup_id = f.id)`).all()).results;
  for (const r of rows) {
    const stmts = [];
    if (!r.token) stmts.push(db.prepare("UPDATE followups SET token = ? WHERE id = ?").bind(newToken(), r.id));
    const has = await db.prepare("SELECT COUNT(*) AS n FROM checkins WHERE followup_id = ?").bind(r.id).first();
    if (!has.n) for (const m of scheduleFor(r.stage, r.consent_version))
      stmts.push(db.prepare("INSERT INTO checkins (followup_id, months, due_at) VALUES (?, ?, ?)").bind(r.id, m, addMonths(r.created_at, m)));
    if (stmts.length) await db.batch(stmts);
  }
}

async function followup(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
  const bad = await readBody(request); if (bad.error) return bad.error;
  const d = bad.d;
  if (d.website) return json({ ok: true }); // honeypot: bots fill the hidden field
  const email = String(d.email || "").trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/.test(email)) return json({ ok: false, error: "email" }, 400);
  if (d.consent !== true) return json({ ok: false, error: "consent" }, 400);
  if (!["A", "B", "C", "D"].includes(d.stage)) return json({ ok: false, error: "stage" }, 400);
  if (typeof d.answers !== "object" || typeof d.result !== "object") return json({ ok: false, error: "fields" }, 400);
  await ensureTables(env.DB);
  const now = new Date().toISOString();
  const r = await env.DB.prepare("INSERT INTO followups (created_at, email, stage, answers, result, consent_version, token) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(now, email, d.stage, JSON.stringify(d.answers), JSON.stringify(d.result), CONSENT_VERSION, newToken()).run();
  const id = r.meta.last_row_id;
  await env.DB.batch(scheduleFor(d.stage, CONSENT_VERSION).map(m =>
    env.DB.prepare("INSERT INTO checkins (followup_id, months, due_at) VALUES (?, ?, ?)").bind(id, m, addMonths(now, m))));
  return json({ ok: true });
}

async function readBody(request) {
  const origin = request.headers.get("origin") || "";
  if (origin && origin !== new URL(request.url).origin) return { error: json({ ok: false, error: "origin" }, 403) }; // same-site only
  const raw = await request.text();
  if (raw.length > MAX_BODY) return { error: json({ ok: false, error: "size" }, 413) };
  try { return { d: JSON.parse(raw) }; } catch { return { error: json({ ok: false, error: "json" }, 400) }; }
}

async function byToken(db, t) {
  if (typeof t !== "string" || t.length < 16 || t.length > 64) return null;
  return db.prepare("SELECT id, stage, stopped FROM followups WHERE token = ?").bind(t).first();
}

const STATUS = ["together", "married", "split"];
const clean = (v, allowed) => (allowed.includes(v) ? v : null);
const num = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

// GET: what to show on the check-in page. POST: save the answers to one check-in.
async function checkin(request, env) {
  await ensureTables(env.DB);
  if (request.method === "GET") {
    const u = new URL(request.url), f = await byToken(env.DB, u.searchParams.get("t"));
    if (!f) return json({ ok: false, error: "link" }, 404);
    const c = await env.DB.prepare("SELECT id, months, answered_at FROM checkins WHERE followup_id = ? AND id = ?").bind(f.id, +u.searchParams.get("c") || 0).first();
    return json({ ok: true, stage: f.stage, stopped: !!f.stopped, months: c ? c.months : null, answered: c ? !!c.answered_at : false, found: !!c });
  }
  if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
  const b = await readBody(request); if (b.error) return b.error;
  const d = b.d, f = await byToken(env.DB, d.t);
  if (!f) return json({ ok: false, error: "link" }, 404);
  const c = await env.DB.prepare("SELECT id FROM checkins WHERE followup_id = ? AND id = ?").bind(f.id, +d.c || 0).first();
  if (!c) return json({ ok: false, error: "checkin" }, 404);
  const status = clean(d.status, STATUS);
  if (!status) return json({ ok: false, error: "status" }, 400);
  const answers = {
    status,
    split_year: status === "split" ? num(d.split_year, 1950, 2100) : null,
    split_month: status === "split" ? num(d.split_month, 1, 12) : null,
    who_ended: status === "split" ? clean(d.who_ended, ["me", "partner", "both", "skip"]) : null,
    satisfaction: status !== "split" ? num(d.satisfaction, 0, 10) : null,
    thought_split: status !== "split" ? clean(d.thought_split, ["never", "once", "often"]) : null,
  };
  const now = new Date().toISOString();
  const stmts = [env.DB.prepare("UPDATE checkins SET answered_at = ?, answers = ? WHERE id = ?").bind(now, JSON.stringify(answers), c.id)];
  // After a split there is nothing left to follow, so later check-ins are dropped.
  if (status === "split") stmts.push(env.DB.prepare("DELETE FROM checkins WHERE followup_id = ? AND sent_at IS NULL AND answered_at IS NULL").bind(f.id));
  await env.DB.batch(stmts);
  return json({ ok: true });
}

async function stopOrDelete(request, env, action) {
  if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
  await ensureTables(env.DB);
  const b = await readBody(request); if (b.error) return b.error;
  const f = await byToken(env.DB, b.d.t);
  if (!f) return json({ ok: false, error: "link" }, 404);
  if (action === "stop") await env.DB.prepare("UPDATE followups SET stopped = 1 WHERE id = ?").bind(f.id).run();
  else await env.DB.batch([env.DB.prepare("DELETE FROM checkins WHERE followup_id = ?").bind(f.id), env.DB.prepare("DELETE FROM followups WHERE id = ?").bind(f.id)]);
  return json({ ok: true });
}

// ---------- emails
const when = m => (m === 6 ? "six months" : m === 12 ? "a year" : `${m / 12} years`);
function emailBody(months, link, stopLink, reminder) {
  const lead = reminder ? "A quick reminder: " : "";
  const text = `${lead}About ${when(months)} ago you used Will We Last and asked us to check in.

One quick question, about 30 seconds: are you still together?
${link}

Your answer is the only way to test whether the odds hold up for real couples. It stays private and is only ever counted in totals.

Don't want these emails? Stop them or delete everything we stored: ${stopLink}

Will We Last · ${SITE}`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:520px">
<p>${lead}About ${when(months)} ago you used <b>Will We Last</b> and asked us to check in.</p>
<p>One quick question, about 30 seconds: are you still together?</p>
<p><a href="${link}" style="display:inline-block;background:#5a4e94;color:#fff;text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:600">Answer the check-in</a></p>
<p>Your answer is the only way to test whether the odds hold up for real couples. It stays private and is only ever counted in totals.</p>
<p style="font-size:13px;color:#666">Don't want these emails? <a href="${stopLink}" style="color:#666">Stop them or delete everything we stored</a>.<br>Will We Last · <a href="${SITE}" style="color:#666">willwelast.app</a></p></div>`;
  return { subject: reminder ? "Reminder: your Will We Last check-in" : "Your Will We Last check-in", text, html };
}

async function sendEmail(env, to, msg, stopLink) {
  const r = await fetch(env.RESEND_URL || "https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], reply_to: REPLY_TO, subject: msg.subject, text: msg.text, html: msg.html,
      headers: { "List-Unsubscribe": `<${stopLink}>` } }),
  });
  return r.ok;
}

async function runCheckins(env) {
  if (!env.DB || !env.RESEND_API_KEY) return { sent: 0, skipped: "not configured" };
  await ensureTables(env.DB);
  await schedule(env.DB);
  const now = new Date(), nowIso = now.toISOString(), remindBefore = new Date(now - REMIND_AFTER_DAYS * 864e5).toISOString();
  const due = (await env.DB.prepare(`SELECT c.id, c.followup_id, c.months, c.sent_at, f.email, f.token FROM checkins c JOIN followups f ON f.id = c.followup_id
    WHERE f.stopped = 0 AND c.answered_at IS NULL AND c.due_at <= ?
      AND (c.sent_at IS NULL OR (c.reminded_at IS NULL AND c.sent_at <= ?))
    ORDER BY c.due_at LIMIT ?`).bind(nowIso, remindBefore, DAILY_LIMIT).all()).results;
  // One email per person per run: if several check-ins are due at once (a missed run), send only the latest.
  const latest = new Map();
  for (const c of due) if (!latest.has(c.followup_id) || latest.get(c.followup_id).months < c.months) latest.set(c.followup_id, c);
  const skipped = due.filter(c => latest.get(c.followup_id) !== c && !c.sent_at);
  if (skipped.length) await env.DB.batch(skipped.map(c => env.DB.prepare("UPDATE checkins SET sent_at = 'skipped', reminded_at = 'skipped' WHERE id = ?").bind(c.id)));
  let sent = 0;
  for (const c of latest.values()) {
    const link = `${SITE}/checkin?t=${c.token}&c=${c.id}`, stopLink = `${SITE}/checkin?t=${c.token}&do=stop`;
    const reminder = !!c.sent_at;
    if (await sendEmail(env, c.email, emailBody(c.months, link, stopLink, reminder), stopLink)) {
      await env.DB.prepare(`UPDATE checkins SET ${reminder ? "reminded_at" : "sent_at"} = ? WHERE id = ?`).bind(nowIso, c.id).run();
      sent++;
    }
  }
  return { sent };
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/status") return json({ followup: Boolean(env.DB) }); // the form only shows once storage is connected
    if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (!env.DB) return json({ ok: false, error: "not ready" }, 503);
    if (pathname === "/api/followup") return followup(request, env);
    if (pathname === "/api/checkin") return checkin(request, env);
    if (pathname === "/api/stop") return stopOrDelete(request, env, "stop");
    if (pathname === "/api/delete") return stopOrDelete(request, env, "delete");
    return json({ ok: false, error: "not found" }, 404);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheckins(env));
  },
};
