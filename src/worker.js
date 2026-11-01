// Handles /api/* only; every other path is served straight from public/ (see run_worker_first in wrangler.jsonc).
// /api/followup stores an opt-in for the accuracy follow-up: email, the calculator answers and the result shown.

const CONSENT_VERSION = "2026-11-01";
const MAX_BODY = 8000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function ensureTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS followups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    email TEXT NOT NULL,
    stage TEXT NOT NULL,
    answers TEXT NOT NULL,
    result TEXT NOT NULL,
    consent_version TEXT NOT NULL
  )`).run();
}

async function followup(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
  const origin = request.headers.get("origin") || "";
  if (origin && origin !== new URL(request.url).origin) return json({ ok: false, error: "origin" }, 403); // same-site form only
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ ok: false, error: "size" }, 413);
  let d;
  try { d = JSON.parse(raw); } catch { return json({ ok: false, error: "json" }, 400); }
  if (d.website) return json({ ok: true }); // honeypot: bots fill the hidden field
  const email = String(d.email || "").trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/.test(email)) return json({ ok: false, error: "email" }, 400);
  if (d.consent !== true) return json({ ok: false, error: "consent" }, 400);
  if (!["A", "B", "C", "D"].includes(d.stage)) return json({ ok: false, error: "stage" }, 400);
  if (typeof d.answers !== "object" || typeof d.result !== "object") return json({ ok: false, error: "fields" }, 400);
  await ensureTable(env.DB);
  await env.DB.prepare("INSERT INTO followups (created_at, email, stage, answers, result, consent_version) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(new Date().toISOString(), email, d.stage, JSON.stringify(d.answers), JSON.stringify(d.result), CONSENT_VERSION)
    .run();
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/status") return json({ followup: Boolean(env.DB) }); // the form only shows once storage is connected
    if (pathname === "/api/followup") return env.DB ? followup(request, env) : json({ ok: false, error: "not ready" }, 503);
    if (pathname.startsWith("/api/")) return json({ ok: false, error: "not found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
