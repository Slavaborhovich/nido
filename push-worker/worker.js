/* Nido push server — Cloudflare Worker, FREE plan only (no card, no paid add-ons, nothing that bills).

   Uses only:  Workers Free (HTTP + 1 cron "* * * * *")  ·  one Workers KV namespace bound as NIDO.
   Secrets (set once, never in code/GitHub/Firestore): VAPID_PUBLIC, VAPID_PRIVATE.
   Free-plan limits this code is built around (see README.md for links):
     100k requests/day · 10 ms CPU per invocation · 50 subrequests per invocation (fetch + every KV call)
     KV: 100k reads · 1k writes · 1k deletes · 1k lists per day · 1 write/second per key. Over a limit → errors.

   SECURITY
   • Every POST needs the caller's Firebase ID token. The worker reads the caller's OWN profile from Firestore
     with that token (Firestore verifies signature/issuer/audience/expiry). Family, role and active come from
     that profile — never from the request. No token cache: role/active are checked on every request.
   • Roles: viewers may only manage their own device (subscribe / unsubscribe / test). Only editors and
     admins may send notifications or replace the family's reminder plan.
   • Recipients are filtered against the family roster (read from Firestore with the caller's token).
   • All storage is keyed by env AND family; a caller can only touch their own family's keys.

   PER-FAMILY PERMISSION — a family gets notifications only if the system admin turned them on
   (families/{fid}.push === true; only he may write it — firestore.rules) AND it is not frozen
   (families/{fid}.active !== false). New families have no 'push' field → off. The cron cannot read Firestore (no
   service key, by design), so authenticated calls that read Firestore themselves copy the setting into KV:
     pol:{fid}  — on/active + time; written by /policy (system admin) and by the family's own members (hourly).
     allow      — { primary, fams } written ONLY by /policy. primary = the family in the system admin's own
                  Firestore profile (no default — a profile without a family stops all sending).
   A setting older than policyMaxAgeMs (48 h) counts as NOT allowed (fail closed). After a confirmed /policy
   change the next cron run that reads it applies it (KV may serve an older value for ~60 s in other locations).

   SENDING — nothing is pushed from HTTP. /send and /test write one queue item (its own key, never modified,
   expires by itself) and a hint; the cron delivers. See "CRON" below for how crashes, overlaps and stale reads
   turn into (rare, bounded) duplicates instead of losses.

   PRIVACY — the owner chose readable notifications ("תהילה הוסיפה: חלב, ביצים"). The client may send a short title
   and body with each item. That text is kept only as long as delivery needs it:
     • queue items — at most queueTtlSec (2 h), then KV deletes them by itself;
     • cron state  — only while a device is waiting/retrying, and never later than lateMs (30 min) after it was due;
     • reminders   — inside the family's plan (jobs:{env}:{family}) until their time (up to 8 days), replaced
                     whenever the plan changes. A plan item without text falls back to the fixed generic text.
   Nothing with text is ever written to the log. Without text, the fixed generic text below is used. */

const PROJECT = "nido-family-72346";
const ORIGIN = "https://slavaborhovich.github.io";
const SUBJECT = "https://slavaborhovich.github.io/nido/";
const ENVS = ["prod", "test"];
const HOME = "home";                                              // the database rules allow the test environment only for this family id
const SUPER = "K2TaGlPsCJQ7W4HPdaOwQqvRKGS2";                    // the system admin (same as the database rules)

/* ---------- limits (conservative for the free plan) ---------- */
export const LIMITS = {
  bodyBytes: 64 * 1024,          // max request body (a 120-item reminder plan with text fits)
  uidsPerCall: 20,               // recipients per /send or per job
  jobsPerFamily: 120,            // reminders in a family's plan (7 days)
  devicesPerUser: 6,
  // daily KV write budgets (UTC day) — counted inside values that are written anyway
  planWritesPerFamily: 96, planWritesPerUser: 48,                  // plans now carry titles → change more often
  subWritesPerFamily: 30, subWritesPerUser: 10,
  queuedPerUserPerDay: 60,       // /send + /test items per person per day (soft: counted in the hint)
  rosterMaxAgeMs: 8 * 864e5,     // older roster → that family's notifications are skipped (fail closed)
  rosterRefreshMs: 6 * 3600e3,
  // per invocation. CPU: NOT measured on Cloudflare — local Node figures only (see README). Keep these small.
  subreqBudget: 30,              // of 50 allowed — ONE budget per invocation; the cron shares it between prod and test
  pushesPerRun: 3,               // devices per cron run, prod + test together
  pushesPerRunTest: 1,           // test gets at most this many, only from what prod left over
  queueItemsPerRun: 3,           // new queue items read per run (the rest stay queued for the next run)
  fetchTimeoutMs: 10e3,          // every outgoing request — keeps a run far shorter than a minute
  sendsPerMinutePerUser: 6,      // in-memory, per worker instance only (best effort)
  // queue + cron state
  queueTtlSec: 2 * 3600,         // a queue item deletes itself after this (KV expiration — no delete operation)
  hintWindowMs: 3 * 60e3,        // after a hint, the cron lists the queue for this long (KV lists can lag)
  listEveryMin: 15,              // safety: list the prod queue every N minutes even without a hint
  listEveryMinTest: 60,
  jobWindowMs: 10 * 60e3,        // each run re-checks the last 10 minutes of reminders (done ids prevent repeats)
  lateMs: 30 * 60e3,             // later than this → dropped and counted, never sent late
  flyResendMs: 2 * 60e3,         // "in flight" from an earlier run for this long → that run died → send again
  retryMax: 3, retryDelayMs: 60e3,
  doneKeepMs: 3 * 3600e3,        // processed ids are remembered longer than a queue item can live
  waitMax: 300,
  digestSpreadMin: 30, remindSpreadMin: 3,
  // permission
  policyRefreshMs: 3600e3,       // a member's call re-reads their family's setting at most hourly
  policyMaxAgeMs: 48 * 3600e3,   // older or missing → NOT allowed
};

/* ---------- generic texts: nothing personal ever reaches the lock screen ---------- */
export const KINDS = {
  remind: { title: "📅 NIDO — יש לך תזכורת", tab: "today" },
  digest: { title: "☀️ NIDO — הסיכום היומי שלך מחכה", tab: "today" },
  task:   { title: "✅ NIDO — יש עדכון לגבי משימה", tab: "tasks" },
  event:  { title: "📅 NIDO — יש עדכון ביומן", tab: "cal" },
  idea:   { title: "💡 NIDO — יש עדכון ברעיונות", tab: "ideas" },
  shop:   { title: "🛒 NIDO — יש עדכון בקניות", tab: "shop" },
  note:   { title: "❤️ NIDO — יש לך פתק חדש על המקרר", tab: "" },
  update: { title: "🆕 NIDO — יש גרסה חדשה", tab: "" },
  test:   { title: "🔔 NIDO — ההתראות עובדות!", tab: "" },
};
const BODY = "פתחו את NIDO כדי לראות";
const SEND_KINDS = ["task", "event", "idea", "shop", "note"];
const JOB_KINDS = ["remind", "digest"];
// tag: a repeated delivery of the same message replaces the earlier notification on the phone instead of stacking.
// x = optional custom text { t: title, b: body, g: tag } — without a title the fixed generic text is used.
export const messageOf = (kind, x) => {
  const k = KINDS[kind]; if (!k) return null;
  if (x && x.t) return { title: x.t, body: x.b || "", tag: x.g || kind, tab: k.tab };
  return { title: k.title, body: BODY, tag: kind, tab: k.tab };
};
/* custom text from the app: plain one-line-ish strings, short, no control characters. Missing → null (generic). */
export const TEXT = { title: 80, body: 180 };
export function textOf(o) {
  const str = (v, max) => {
    if (v === undefined || v === null || v === "") return "";
    if (typeof v !== "string") throw new Fail(400, "bad-text");
    const t = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\s+\n/g, "\n").trim();
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
  };
  const t = str(o.title, TEXT.title), b = str(o.body, TEXT.body);
  if (o.tag !== undefined && o.tag !== null && o.tag !== "" && !(typeof o.tag === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(o.tag))) throw new Fail(400, "bad-tag");
  if (!t) return null;
  const x = { t }; if (b) x.b = b; if (o.tag) x.g = o.tag;
  return x;
}

/* ---------- helpers ---------- */
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4)), c => c.charCodeAt(0));
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const cors = { "Access-Control-Allow-Origin": ORIGIN, "Access-Control-Allow-Headers": "content-type, authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Max-Age": "86400" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...cors } });
const isId = s => typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s);
const today = () => new Date().toISOString().slice(0, 10);
const hash32 = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
async function sha(s) { return b64u(await crypto.subtle.digest("SHA-256", enc.encode(s))).slice(0, 32); }
const timeout = () => (typeof AbortSignal !== "undefined" && AbortSignal.timeout) ? AbortSignal.timeout(LIMITS.fetchTimeoutMs) : undefined;
const K = {
  subs: (e, f) => `subs:${e}:${f}`,      // { day, w:{uid:n}, n, list:{ uid:[sub,…] } }   — /subscribe, /unsubscribe, cron (dead ones)
  jobs: (e, f) => `jobs:${e}:${f}`,      // { day, w:{uid:n}, n, jobs:[{at,k,u:[uid]}] }   — /jobs
  roster: (e, f) => `roster:${e}:${f}`,  // { at, users:{ uid:{a:1|0, r} } }               — roster refresh
  pol: f => `pol:${f}`,                  // { on, act, at }                                — /policy, members (hourly)
  allow: () => "allow",                  // { primary, fams:[fid], at }                    — /policy ONLY
  q: (e, f, id) => `q:${e}:${f}:${id}`,  // { k, u:[uid], at, by }  never modified, expires — /send, /test
  qPrefix: e => `q:${e}:`,
  hint: e => `qhint:${e}`,               // { t, day, n:{uid:count} }                      — /send, /test
  cron: e => `cron:${e}`,                // cron state (see runCron)                       — cron ONLY
  dev: h => `dev:${h}`,                  // { e, f, u }
};
/* A family may get notifications only when ALL of these hold — anything missing, invalid or old → not allowed. */
export const allowed = p => !!p && typeof p === "object" && p.on === true && p.act === true
  && typeof p.at === "number" && Date.now() - p.at < LIMITS.policyMaxAgeMs;
class Fail extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

/* budget per invocation: every fetch and every KV call (incl. list) is a subrequest on the free plan */
function budget(limit = LIMITS.subreqBudget) {
  return { used: 0, take(n = 1) { if (this.used + n > limit) throw new Fail(503, "busy"); this.used += n; }, left() { return limit - this.used; } };
}
const kv = {
  async get(env, b, key) { b.take(); try { return await env.NIDO.get(key, "json"); } catch (e) { throw new Fail(503, "storage"); } },
  async put(env, b, key, v, opt) { b.take(); try { await env.NIDO.put(key, JSON.stringify(v), opt); } catch (e) { throw new Fail(503, "storage"); } },
  async del(env, b, key) { b.take(); try { await env.NIDO.delete(key); } catch (e) { throw new Fail(503, "storage"); } },
  async list(env, b, prefix) { b.take(); try { return (await env.NIDO.list({ prefix, limit: 100 })).keys.map(k => k.name); } catch (e) { throw new Fail(503, "storage"); } },
};
/* daily write counters live inside the value itself → enforcing the limit costs no extra writes */
function charge(doc, uid, perUser, perFamily) {
  const d = today();
  if (doc.day !== d) { doc.day = d; doc.w = {}; doc.n = 0; }
  if ((doc.n || 0) >= perFamily || ((doc.w || {})[uid] || 0) >= perUser) throw new Fail(429, "daily-limit");
  doc.n = (doc.n || 0) + 1; doc.w = { ...(doc.w || {}), [uid]: ((doc.w || {})[uid] || 0) + 1 };
}

/* ---------- VAPID (from secrets only — no key is ever generated here) ---------- */
let SIGNKEY = null; const JWT = new Map();
function vapidReady(env) { return typeof env.VAPID_PUBLIC === "string" && env.VAPID_PUBLIC.length > 40 && typeof env.VAPID_PRIVATE === "string" && env.VAPID_PRIVATE.length > 20; }
async function vapidHeader(env, endpoint) {
  const aud = new URL(endpoint).origin, hit = JWT.get(aud);
  if (hit && hit.exp > Date.now() + 60e3) return hit.h;
  if (!SIGNKEY) {
    const pub = unb64u(env.VAPID_PUBLIC);                        // 65 bytes: 0x04 | x | y
    SIGNKEY = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), d: env.VAPID_PRIVATE, ext: false },
      { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  }
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp, sub: SUBJECT })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, SIGNKEY, enc.encode(`${head}.${body}`));
  const h = `vapid t=${head}.${body}.${b64u(sig)}, k=${env.VAPID_PUBLIC}`;
  JWT.set(aud, { h, exp: exp * 1000 });
  return h;
}

/* ---------- RFC 8291 payload encryption (aes128gcm) ---------- */
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}
async function encrypt(sub, text) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, secret, cat(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(enc.encode(text), new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub, ct);
}
/* ONE attempt (retries happen in later cron runs). result: "ok" | "gone" (remove) | "temp" (retry later) | "error" */
async function pushOne(env, b, sub, msg) {
  let payload;
  try { payload = await encrypt(sub, JSON.stringify({ data: msg })); } catch (e) { return "gone"; }   // unusable keys: permanent
  b.take();
  let st = 0;
  try {
    const r = await fetch(sub.endpoint, { method: "POST", signal: timeout(), headers: { TTL: "86400", Urgency: "normal", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Authorization: await vapidHeader(env, sub.endpoint) }, body: payload });
    st = r.status;
  } catch (e) { st = 0; }                                                                         // network / timeout: may or may not have arrived
  if (st >= 200 && st < 300) return "ok";
  if (st === 404 || st === 410) return "gone";                                                    // RFC 8030: subscription expired/unsubscribed
  if (st === 0 || st === 429 || st >= 500) return "temp";
  return "error";                                                                                 // 400/401/403/413…: kept, counted
}

/* ---------- a family's members and devices (one read each, cached per invocation) ---------- */
async function famCtx(env, b, envName, fam, cache) {
  const key = envName + "|" + fam;
  if (key in cache) return cache[key];
  const roster = await kv.get(env, b, K.roster(envName, fam));
  if (!roster || !roster.users || !(Date.now() - roster.at < LIMITS.rosterMaxAgeMs)) return (cache[key] = null);   // fail closed
  const subs = (await kv.get(env, b, K.subs(envName, fam))) || { list: {} };
  return (cache[key] = { roster, subs, dead: [] });
}
/* the device must belong to an active member right now */
function subOf(ctx, unit) {
  const ru = ctx && ctx.roster.users[unit.u];
  if (!ru || !ru.a) return null;
  return ((ctx.subs.list || {})[unit.u] || []).find(s => s.endpoint === unit.e) || null;
}

/* ---------- Firestore with the caller's own token ---------- */
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
async function caller(req, b) {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!tok || tok.length > 4096) return null;
  let claims; try { claims = JSON.parse(new TextDecoder().decode(unb64u(tok.split(".")[1]))); } catch (e) { return null; }
  // cheap pre-checks only — the real verification (signature, issuer, audience, expiry) is done by Firestore below
  if (claims.aud !== PROJECT || claims.iss !== `https://securetoken.google.com/${PROJECT}` || !isId(claims.user_id) || claims.sub !== claims.user_id || !(claims.exp * 1000 > Date.now())) return null;
  b.take();
  let r; try { r = await fetch(`${FS}/users/${claims.user_id}`, { headers: { Authorization: `Bearer ${tok}` }, signal: timeout() }); } catch (e) { throw new Fail(503, "auth-unavailable"); }
  if (!r.ok) return null;
  const f = (await r.json()).fields || {};
  if (!f.active || f.active.booleanValue !== true) return null;                                   // disabled people (and frozen families' people)
  const role = f.role && f.role.stringValue;
  if (!["admin", "editor", "viewer"].includes(role)) return null;
  const raw = f.family && f.family.stringValue, famSet = isId(raw);
  // regular users: a missing family means "home" — exactly what the database rules assume (myFamily()).
  // The PRIMARY family is never defaulted: /policy refuses to work unless the admin's profile names a family.
  return { uid: claims.user_id, fam: famSet ? raw : HOME, famSet, role, tok, isSuper: claims.user_id === SUPER };
}
/* the family's members (uid → active/role), read with the caller's token — the rules decide what they may list */
async function fetchRoster(b, who, fam) {
  b.take();
  let r;
  try {
    r = await fetch(`${FS}:runQuery`, { method: "POST", signal: timeout(), headers: { Authorization: `Bearer ${who.tok}`, "content-type": "application/json" },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "users" }], where: { fieldFilter: { field: { fieldPath: "family" }, op: "EQUAL", value: { stringValue: fam } } }, limit: 100 } }) });
  } catch (e) { throw new Fail(503, "roster-unavailable"); }
  if (!r.ok) throw new Fail(r.status === 403 ? 403 : 503, "roster");
  const users = {};
  for (const row of await r.json()) {
    const d = row.document; if (!d) continue;
    const uid = d.name.split("/").pop(), f = d.fields || {};
    if (!isId(uid)) continue;
    users[uid] = { a: f.active && f.active.booleanValue === true ? 1 : 0, r: (f.role && f.role.stringValue) || "viewer" };
    const nu = f.notif && f.notif.mapValue && f.notif.mapValue.fields && f.notif.mapValue.fields.update;
    if (nu && nu.booleanValue === false) users[uid].nu = 1;                                         // turned off "new version" notifications
  }
  return users;
}
/* refresh the roster when stale (or forced); remove devices of people who are no longer active members */
async function syncRoster(env, b, envName, who, fam, force) {
  const key = K.roster(envName, fam), cur = await kv.get(env, b, key);
  if (!force && cur && Date.now() - cur.at < LIMITS.rosterRefreshMs) return cur;
  const users = await fetchRoster(b, who, fam);
  const next = { at: Date.now(), users };
  const changed = !cur || JSON.stringify(cur.users) !== JSON.stringify(users);
  if (changed || !cur || Date.now() - cur.at >= LIMITS.rosterRefreshMs) await kv.put(env, b, key, next);
  if (changed) {
    const sk = K.subs(envName, fam), doc = await kv.get(env, b, sk);
    if (doc && doc.list) {
      let dirty = false;
      for (const uid of Object.keys(doc.list)) if (!users[uid] || !users[uid].a) { delete doc.list[uid]; dirty = true; }
      if (dirty) await kv.put(env, b, sk, doc);
    }
    if (!Object.keys(users).length) for (const k of [K.subs(envName, fam), K.jobs(envName, fam), K.roster(envName, fam)]) await kv.del(env, b, k);   // family gone
  }
  return next;
}

/* ---------- per-family permission ---------- */
function policyFrom(fields) {
  const f = fields || {};
  const on = !!(f.push && f.push.booleanValue === true);
  const act = !f.active || f.active.booleanValue === true;                                     // missing = active (as in the app); anything else = frozen
  return { on, act };
}
async function fetchFamily(b, who, fam) {
  b.take();
  let r; try { r = await fetch(`${FS}/families/${fam}`, { headers: { Authorization: `Bearer ${who.tok}` }, signal: timeout() }); } catch (e) { throw new Fail(503, "policy-unavailable"); }
  if (r.status === 404) return null;                                                            // the family no longer exists
  if (!r.ok) throw new Fail(503, "policy-unavailable");
  return policyFrom((await r.json()).fields);
}
async function listFamilies(b, who) {                                                           // the system admin only (rules: boot may read families)
  b.take();
  let r; try { r = await fetch(`${FS}/families?pageSize=100&mask.fieldPaths=push&mask.fieldPaths=active`, { headers: { Authorization: `Bearer ${who.tok}` }, signal: timeout() }); } catch (e) { throw new Fail(503, "policy-unavailable"); }
  if (!r.ok) throw new Fail(503, "policy-unavailable");
  const out = {};
  for (const d of (await r.json()).documents || []) { const id = d.name.split("/").pop(); if (isId(id)) out[id] = policyFrom(d.fields); }
  return out;
}
/* write pol:{fam} when something changed or the stored copy is older than the refresh interval (renews the 48 h) */
async function storePolicy(env, b, fam, cur, next) {
  const same = cur && cur.on === next.on && cur.act === next.act;
  if (same && Date.now() - cur.at < LIMITS.policyRefreshMs) return cur;
  const doc = { on: next.on, act: next.act, at: Date.now() };
  await kv.put(env, b, K.pol(fam), doc);
  return doc;
}
/* the caller's own family: re-read from Firestore when missing or older than an hour */
async function ensurePolicy(env, b, who, fam) {
  const cur = await kv.get(env, b, K.pol(fam));
  if (cur && Date.now() - cur.at < LIMITS.policyRefreshMs) return cur;
  const p = await fetchFamily(b, who, fam);
  if (!p) return null;
  return storePolicy(env, b, fam, cur, p);
}
const report = (f, p, verified) => ({ on: p.on, act: p.act, at: p.at, allowed: allowed(p), until: p.at + LIMITS.policyMaxAgeMs, verified });

/* ---------- device ownership ---------- */
async function detach(env, b, ep) {
  const dk = K.dev(await sha(ep)), d = await kv.get(env, b, dk);
  if (!d) return;
  const sk = K.subs(d.e, d.f), doc = await kv.get(env, b, sk);
  if (doc && doc.list && doc.list[d.u]) {
    doc.list[d.u] = doc.list[d.u].filter(s => s.endpoint !== ep); if (!doc.list[d.u].length) delete doc.list[d.u];
    await kv.put(env, b, sk, doc);
  }
  await kv.del(env, b, dk);
}

/* ---------- input validation ---------- */
async function readBody(req) {
  const len = +(req.headers.get("content-length") || 0);
  if (len > LIMITS.bodyBytes) throw new Fail(413, "too-large");
  const t = await req.text();
  if (t.length > LIMITS.bodyBytes) throw new Fail(413, "too-large");
  let b; try { b = JSON.parse(t); } catch (e) { throw new Fail(400, "bad-json"); }
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new Fail(400, "bad-body");
  return b;
}
const uidList = (v, max) => {
  if (!Array.isArray(v) || v.length > max) throw new Fail(400, "bad-uids");
  if (!v.every(isId)) throw new Fail(400, "bad-uids");
  return [...new Set(v)];
};
function validSub(s) {
  if (!s || typeof s !== "object" || typeof s.endpoint !== "string" || s.endpoint.length > 1000 || !/^https:\/\/[^\s]+$/.test(s.endpoint)) return null;
  const k = s.keys || {};
  if (typeof k.p256dh !== "string" || typeof k.auth !== "string" || !/^[A-Za-z0-9_-]{80,100}$/.test(k.p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(k.auth)) return null;
  return { endpoint: s.endpoint, keys: { p256dh: k.p256dh, auth: k.auth } };
}

/* best-effort in-memory throttle (per worker instance — NOT global) */
const RATE = new Map();
function throttle(key, max) {
  const now = Date.now(), w = (RATE.get(key) || []).filter(t => t > now - 60e3);
  if (w.length >= max) return false;
  w.push(now); RATE.set(key, w); if (RATE.size > 2000) RATE.clear(); return true;
}

/* ---------- scheduling helpers ---------- */
export function slotOf(job, fam) {                                                                 // stable spread, minute-aligned
  const spread = job.k === "digest" ? LIMITS.digestSpreadMin : LIMITS.remindSpreadMin;
  return job.at + (hash32(`${fam}|${job.k}|${job.u.join(",")}`) % spread) * 60e3;
}

/* ---------- the queue: one immutable key per request ----------
   Two requests never write the same item key (time + 72 random bits), so concurrent sends cannot overwrite each
   other. The hint (one shared key) only says "something was queued"; losing a hint write costs at most a delay
   (the cron also lists the queue every listEveryMin minutes). */
async function enqueue(env, b, envName, fam, uid, kind, uids, text) {
  const hk = K.hint(envName), hint = (await kv.get(env, b, hk)) || {};
  const d = today(), n = hint.day === d ? { ...(hint.n || {}) } : {};
  if ((n[uid] || 0) >= LIMITS.queuedPerUserPerDay) throw new Fail(429, "daily-limit");
  const id = Date.now().toString(36).padStart(9, "0") + "-" + b64u(crypto.getRandomValues(new Uint8Array(9)));
  await kv.put(env, b, K.q(envName, fam, id), { k: kind, u: uids, at: Date.now(), by: uid, ...(text || {}) }, { expirationTtl: LIMITS.queueTtlSec });
  n[uid] = (n[uid] || 0) + 1;
  try { await kv.put(env, b, hk, { t: Date.now(), day: d, n }); } catch (e) { /* the item is stored; the cron's safety listing finds it */ }
  return id;
}

/* ---------- "new version" — called by the deploy workflow (GitHub Actions), not by a person ----------
   Auth: header x-nido-key must equal the secret ANNOUNCE_KEY (set in Cloudflare and in GitHub; never in code).
   Without the secret the endpoint is closed. Recipients: active members (from the stored roster) of every family that
   is allowed right now — test: the home family only. People who turned "new version" off (roster nu) are skipped. */
function sameSecret(a, c) {
  if (typeof a !== "string" || typeof c !== "string" || a.length !== c.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ c.charCodeAt(i);
  return d === 0;
}
async function announce(req, env, b, envName, body) {
  const key = env.ANNOUNCE_KEY;
  if (typeof key !== "string" || key.length < 24) throw new Fail(503, "not-configured");
  if (!sameSecret(req.headers.get("x-nido-key") || "", key)) return json({ error: "unauthorized" }, 401);
  const text = textOf(body);
  if (!text) throw new Fail(400, "bad-text");
  const allow = (await kv.get(env, b, K.allow())) || {};
  const fams = envName === "test" ? [HOME] : (Array.isArray(allow.fams) ? allow.fams.filter(isId) : []);
  const out = {};
  for (const f of fams.slice(0, 10)) {
    if (b.left() < 6) { out[f] = "busy"; continue; }
    if (!(Array.isArray(allow.fams) && allow.fams.includes(f)) || !allowed(await kv.get(env, b, K.pol(f)))) { out[f] = "off"; continue; }
    const roster = await kv.get(env, b, K.roster(envName, f));
    if (!roster || !roster.users || !(Date.now() - roster.at < LIMITS.rosterMaxAgeMs)) { out[f] = "no-roster"; continue; }
    const uids = Object.entries(roster.users).filter(([, u]) => u.a && !u.nu).map(([u]) => u).slice(0, LIMITS.uidsPerCall);
    if (!uids.length) { out[f] = 0; continue; }
    await enqueue(env, b, envName, f, "deploy", "update", uids, { ...text, g: text.g || "update" });
    out[f] = uids.length;
  }
  return json({ ok: true, families: out });
}

/* ================= HTTP ================= */
async function handle(req, env) {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const path = new URL(req.url).pathname;
  if (req.method === "GET" && path === "/vapid") return vapidReady(env) ? json({ key: env.VAPID_PUBLIC }) : json({ error: "not-configured" }, 503);
  if (req.method !== "POST") return json({ ok: true, service: "nido-push" });
  if (!vapidReady(env)) return json({ error: "not-configured" }, 503);

  const b = budget();
  const body = await readBody(req);
  const envName = ENVS.includes(body.env) ? body.env : null;
  if (!envName) throw new Fail(400, "bad-env");
  if (path === "/announce") return announce(req, env, b, envName, body);
  const who = await caller(req, b);
  if (!who) return json({ error: "unauthorized" }, 401);
  if (envName === "test" && who.fam !== HOME) throw new Fail(403, "forbidden");
  const { uid, fam, role } = who, canEdit = role === "admin" || role === "editor";

  if (path === "/policy") {                                                                         // the system admin only
    if (!who.isSuper) throw new Fail(403, "forbidden");
    if (!who.famSet) throw new Fail(409, "no-primary");                                             // never guess the primary family
    const primary = fam, out = {};
    const curAllow = (await kv.get(env, b, K.allow())) || {};
    const fams = new Set(Array.isArray(curAllow.fams) ? curAllow.fams.filter(isId) : []);
    if (body.fam !== undefined) {                                                                   // one family: after a change in the admin screen
      if (!isId(body.fam)) throw new Fail(400, "bad-fam");
      const f = body.fam, cur = await kv.get(env, b, K.pol(f));
      let p, verified = true;
      try { p = await fetchFamily(b, who, f); }
      catch (e) {                                                                                   // Firestore unreachable: only the SAFE direction may be applied
        if (body.off !== true && body.frozen !== true) throw e;
        p = { on: !!(cur && cur.on === true), act: !!(cur && cur.act === true) }; verified = false;
      }
      if (!p) {                                                                                     // the family was deleted
        for (const e of ENVS) for (const k of [K.subs(e, f), K.jobs(e, f), K.roster(e, f)]) await kv.del(env, b, k);
        if (cur) await kv.del(env, b, K.pol(f));
        fams.delete(f);
        out[f] = { gone: true, allowed: false, verified: true };
      } else {
        if (body.off === true) p = { ...p, on: false };                                            // hints can only restrict, never allow
        if (body.frozen === true) p = { ...p, act: false };
        const next = await storePolicy(env, b, f, cur, p);
        if (allowed(next)) {
          fams.add(f);
          // refresh the members list with the admin's sign-in, so it works without anyone in that family opening the app
          for (const e of ENVS) if (e === "prod" || f === HOME) await syncRoster(env, b, e, who, f, true);
        } else fams.delete(f);
        out[f] = report(f, next, verified);
      }
    } else {                                                                                        // all families: when the admin's app opens
      const all = await listFamilies(b, who);
      for (const [f, p] of Object.entries(all)) {
        if (b.left() < 4) { out[f] = { pending: true }; continue; }                                 // membership in `allow` left as it was
        const next = await storePolicy(env, b, f, await kv.get(env, b, K.pol(f)), p);
        if (allowed(next)) fams.add(f); else fams.delete(f);
        out[f] = report(f, next, true);
      }
      for (const f of [...fams]) if (!(f in all)) fams.delete(f);                                   // deleted families
    }
    const nextAllow = { primary, fams: [...fams].sort() };
    if (curAllow.primary !== nextAllow.primary || JSON.stringify(curAllow.fams || []) !== JSON.stringify(nextAllow.fams))
      await kv.put(env, b, K.allow(), { ...nextAllow, at: Date.now() });
    return json({ ok: true, primary, allow: nextAllow.fams, families: out });
  }

  // every other call works on a family's notification data → that family must be allowed first (checked before any of
  // its data is read or written). /unsubscribe stays open: removing your own device is always safe.
  let target = fam;
  if (path === "/roster" && body.fam !== undefined) {
    if (!isId(body.fam)) throw new Fail(400, "bad-fam");
    target = body.fam;
    if (target !== fam && !who.isSuper) throw new Fail(403, "forbidden");                           // only the system admin may refresh another family
  }
  if (path !== "/unsubscribe" && !allowed(await ensurePolicy(env, b, who, target))) throw new Fail(403, "push-off");

  if (path === "/subscribe") {
    const s = validSub(body.sub); if (!s) throw new Fail(400, "bad-sub");
    const dk = K.dev(await sha(s.endpoint)), cur = await kv.get(env, b, dk);
    await syncRoster(env, b, envName, who, fam, false);                                            // may clean the family's devices
    const sk = K.subs(envName, fam);
    let doc = (await kv.get(env, b, sk)) || { list: {} };
    const listed = ((doc.list || {})[uid] || []).some(x => x.endpoint === s.endpoint && x.keys.p256dh === s.keys.p256dh && x.keys.auth === s.keys.auth);
    if (cur && cur.e === envName && cur.f === fam && cur.u === uid && listed) return json({ ok: true, same: true });   // already registered → nothing to write
    charge(doc, uid, LIMITS.subWritesPerUser, LIMITS.subWritesPerFamily);                          // throws when over the daily limit
    if (cur) {                                                                                     // the device left its old user/family
      await detach(env, b, s.endpoint);
      if (cur.e === envName && cur.f === fam) { const re = (await kv.get(env, b, sk)) || { list: {} }; re.day = doc.day; re.w = doc.w; re.n = doc.n; doc = re; }
    }
    doc.list = doc.list || {};
    doc.list[uid] = [...(doc.list[uid] || []).filter(x => x.endpoint !== s.endpoint), s].slice(-LIMITS.devicesPerUser);
    await kv.put(env, b, sk, doc);
    await kv.put(env, b, dk, { e: envName, f: fam, u: uid });
    return json({ ok: true });
  }
  if (path === "/unsubscribe") {
    if (typeof body.endpoint !== "string" || body.endpoint.length > 1000) throw new Fail(400, "bad-endpoint");
    const d = await kv.get(env, b, K.dev(await sha(body.endpoint)));
    if (!d) return json({ ok: true, none: true });
    if (!(d.e === envName && d.f === fam && d.u === uid)) throw new Fail(403, "forbidden");        // only the device's own user
    await detach(env, b, body.endpoint);
    return json({ ok: true });
  }
  if (path === "/test") {                                                                          // your own devices — through the queue like everything else
    if (!throttle(`t:${uid}`, 3)) throw new Fail(429, "slow-down");
    await syncRoster(env, b, envName, who, fam, false);
    await enqueue(env, b, envName, fam, uid, "test", [uid]);
    return json({ ok: true, queued: 1 });
  }
  if (path === "/send") {                                                                          // queued only — the cron delivers
    if (!canEdit) throw new Fail(403, "read-only");
    if (!SEND_KINDS.includes(body.kind)) throw new Fail(400, "bad-kind");
    const text = textOf(body);
    const asked = uidList(body.uids, LIMITS.uidsPerCall).filter(x => x !== uid);
    if (!throttle(`s:${uid}`, LIMITS.sendsPerMinutePerUser)) throw new Fail(429, "slow-down");
    if (!asked.length) return json({ ok: true, queued: 0 });
    const roster = await syncRoster(env, b, envName, who, fam, false);
    const uids = asked.filter(x => roster.users[x] && roster.users[x].a);
    if (!uids.length) return json({ ok: true, queued: 0, skipped: asked.length });
    await enqueue(env, b, envName, fam, uid, body.kind, uids, text);
    return json({ ok: true, queued: uids.length, skipped: asked.length - uids.length });
  }
  if (path === "/jobs") {
    if (!canEdit) throw new Fail(403, "read-only");
    if (!Array.isArray(body.jobs) || body.jobs.length > LIMITS.jobsPerFamily) throw new Fail(400, "bad-jobs");
    const now = Date.now(), jobs = [];
    for (const j of body.jobs) {
      if (!j || typeof j !== "object" || !JOB_KINDS.includes(j.kind) || typeof j.at !== "number" || !isFinite(j.at)) throw new Fail(400, "bad-job");
      if (!(j.at > now && j.at < now + 8 * 864e5)) continue;                                        // past or too far: ignored
      jobs.push({ at: Math.floor(j.at / 60e3) * 60e3, k: j.kind, u: uidList(j.uids, LIMITS.uidsPerCall), ...(textOf(j) || {}) });
    }
    const roster = await syncRoster(env, b, envName, who, fam, false);
    const clean = jobs.map(j => ({ ...j, u: j.u.filter(x => roster.users[x] && roster.users[x].a) })).filter(j => j.u.length)
      .sort((a, c) => a.at - c.at || a.k.localeCompare(c.k) || a.u.join().localeCompare(c.u.join()) || (a.t || "").localeCompare(c.t || ""));
    const key = K.jobs(envName, fam), doc = (await kv.get(env, b, key)) || {};
    if (JSON.stringify(doc.jobs || []) === JSON.stringify(clean)) return json({ ok: true, jobs: clean.length, same: true });   // every member sends the same plan → write once
    charge(doc, uid, LIMITS.planWritesPerUser, LIMITS.planWritesPerFamily);
    doc.jobs = clean;
    await kv.put(env, b, key, doc);
    return json({ ok: true, jobs: clean.length });
  }
  if (path === "/roster") {                                                                         // after an admin disables / deletes / changes someone
    if (role !== "admin" && !who.isSuper) throw new Fail(403, "forbidden");
    const r = await syncRoster(env, b, envName, who, target, true);
    return json({ ok: true, members: Object.keys(r.users || {}).length });
  }
  throw new Fail(404, "not-found");
}

/* ================= CRON =================
   State per env lives in ONE key (cron:{env}) that only the cron writes:
     done  { id: time }   queue items and reminder occurrences already taken in (so they are never taken twice)
     fly   [unit]         devices chosen by a run that has not confirmed the result yet (unit = one device of one person)
     retry [unit]         temporary failures, retried by later runs (at most retryMax attempts, never later than lateMs)
     wait  [unit]         due, but did not fit into a run
   One run, per env (prod first, then test with what is left):
     1. read allow + each family's permission once; a family that is not allowed is never read (its waiting work is
        dropped and counted). If a permission can't be read, that family's work waits untouched.
     2. take in: units still "in flight" from a run that died (older than flyResendMs), due retries, waiting units,
        new queue items (only when a hint is recent or on the safety schedule), reminders of the last jobWindowMs.
     3. pick up to the device cap: primary family first, then the others; oldest first.
     4. WRITE 1: chosen → fly, the rest → wait, new ids → done. If this write fails, nothing is sent and nothing
        advanced: the next run sees exactly the same input (no loss).
     5. send each chosen device ONCE.
     6. WRITE 2: remove what was delivered; temporary failures → retry; dead subscriptions removed.
   What this guarantees, and what it doesn't (KV has no locks and no conditional writes):
     • crash / CPU limit between 4 and 6 → the units stay in `fly` → re-sent after flyResendMs → a DUPLICATE
       (if it had gone out), not a loss. Write 2 failing → same.
     • two overlapping runs, or a stale read of cron:{env} → both can pick the same units → DUPLICATES (≤ device cap).
       Whichever write lands last wins; the losing run's units are either delivered already or still in fly/done
       of the winning state — they are re-sent, not lost. A per-instance memory of the last written version reduces
       stale reads when the same instance runs again.
     • a temporary push failure that actually arrived → retry → DUPLICATE.
     • phones show notifications with tag = kind, so a duplicate replaces the earlier one (it may sound again).
     • LOSS only when: work is later than lateMs (worker/KV down for a long time), a retry runs out, a queue item
       expires unread (2 h), or a daily KV limit is reached. Every one of those is counted in the run report. */
const MEM = {};                                                                                     // last state this instance wrote, per env
const clone = o => JSON.parse(JSON.stringify(o));
async function loadState(env, b, envName) {
  const s = await kv.get(env, b, K.cron(envName));
  const m = MEM[envName];
  const st = m && (!s || (m.v || 0) > (s.v || 0)) ? clone(m) : (s || {});
  return { v: st.v || 0, done: st.done || {}, fly: st.fly || [], retry: st.retry || [], wait: st.wait || [], more: st.more === true };
}
async function saveState(env, b, envName, st) {
  st.v = (st.v || 0) + 1;
  await kv.put(env, b, K.cron(envName), st);
  MEM[envName] = clone(st);
}
const unitId = (src, uid, ep) => `${src}|${uid}|${hash32(ep).toString(36)}`;
const isUnit = u => u && typeof u === "object" && isId(u.f) && isId(u.u) && typeof u.e === "string" && typeof u.k === "string" && typeof u.at === "number" && typeof u.id === "string";

export async function runCron(env, scheduledTime) {
  const rep = { sent: 0, failed: 0, retried: 0, resent: 0, skipped: 0, removed: 0, dropped: 0, blocked: 0, waiting: 0, errors: 0 };
  if (!vapidReady(env)) return rep;
  const to = Math.floor(scheduledTime / 60e3) * 60e3, minute = Math.floor(to / 60e3), now = Date.now();
  const b = budget(), pols = {}, run = b64u(crypto.getRandomValues(new Uint8Array(6)));
  let allow;
  try { allow = (await kv.get(env, b, K.allow())) || {}; } catch (e) { rep.errors++; return rep; }      // can't know who is allowed → do nothing
  const listed = new Set(Array.isArray(allow.fams) ? allow.fams.filter(isId) : []);
  const primary = isId(allow.primary) ? allow.primary : null;
  const perm = async f => {                                                                         // true | false | undefined (unknown this run)
    if (!isId(f) || !listed.has(f)) return false;
    if (!(f in pols)) { try { pols[f] = await kv.get(env, b, K.pol(f)); } catch (e) { return undefined; } }
    return allowed(pols[f]);
  };
  // primary first, then the others (rotating so none of them always comes last)
  const others = [...listed].filter(f => f !== primary).sort(), sh = others.length ? minute % others.length : 0;
  const order = [...(primary && listed.has(primary) ? [primary] : []), ...others.slice(sh), ...others.slice(0, sh)];
  const rank = f => { const i = order.indexOf(f); return i < 0 ? order.length : i; };
  let pushesLeft = LIMITS.pushesPerRun;

  for (const envName of ENVS) {
    const cap = Math.min(pushesLeft, envName === "prod" ? LIMITS.pushesPerRun : LIMITS.pushesPerRunTest);
    const cache = {};
    let st, hint;
    try { st = await loadState(env, b, envName); hint = await kv.get(env, b, K.hint(envName)); }
    catch (e) { rep.errors++; continue; }
    const done = Object.fromEntries(Object.entries(st.done).filter(([, t]) => now - t < LIMITS.doneKeepMs));
    const ok = {}, okf = async f => (f in ok ? ok[f] : (ok[f] = await perm(f)));                    // read lazily, only when needed
    const RESERVE = 14;                                                                             // what a run needs to finish its sends + writes
    const roomFor = f => f === primary || b.left() >= RESERVE;                                      // other families only use what is left
    if (primary) await okf(primary);
    for (const u of [...st.fly, ...st.retry, ...st.wait]) if (u && isId(u.f) && !(u.f in ok) && roomFor(u.f)) await okf(u.f);

    // 1. work carried over
    const hold = { fly: [], retry: [], wait: [] }, cand = [];
    const carried = (list, kind) => {
      for (const u of list) {
        if (!isUnit(u) || ok[u.f] === false) { rep.blocked++; continue; }                          // turned off / frozen / unknown family → never sent
        if (ok[u.f] !== true) { hold[kind].push(u); continue; }                                     // permission unreadable now → wait untouched
        if (to - u.at > LIMITS.lateMs) { rep.dropped++; continue; }
        if (kind === "fly") { if (now - (u.t || 0) >= LIMITS.flyResendMs) { cand.push({ ...u, pr: 0 }); rep.resent++; } else hold.fly.push(u); continue; }
        if (kind === "retry") { if ((u.next || 0) <= now) cand.push({ ...u, pr: 1 }); else hold.retry.push(u); continue; }
        cand.push({ ...u, pr: 2 });
      }
    };
    carried(st.fly, "fly"); carried(st.retry, "retry"); carried(st.wait, "wait");

    // 2a. new queue items (list only after a recent hint, or on the safety schedule)
    const newSrc = [];                                                                              // { id, f, k, at, u:[uid] }
    const every = envName === "prod" ? LIMITS.listEveryMin : LIMITS.listEveryMinTest;
    const wantList = st.more || (hint && now - (hint.t || 0) <= LIMITS.hintWindowMs) || minute % every === 0;
    let more = wantList ? false : st.more;
    if (wantList && b.left() >= 10) {
      try {
        let taken = 0;
        const names = (await kv.list(env, b, K.qPrefix(envName))).map(n => [n, n.split(":")[2]])
          .sort((x, y) => (x[1] === primary ? 0 : 1) - (y[1] === primary ? 0 : 1) || (x[0] < y[0] ? -1 : 1)).map(x => x[0]);   // primary first
        for (const name of names) {
          const [, , f, qid] = name.split(":");
          if (!qid || done[name]) continue;
          const at = parseInt(qid.split("-")[0], 36);
          if (isId(f) && !(f in ok)) { if (!roomFor(f)) { more = true; continue; } await okf(f); }   // not in `allow` → false without any read
          if (ok[f] === false || !isId(f)) { done[name] = now; rep.blocked++; continue; }           // never read a disallowed family's item
          if (ok[f] !== true) continue;
          if (!(at > 0) || to - at > LIMITS.lateMs) { done[name] = now; rep.dropped++; continue; }
          if (taken >= LIMITS.queueItemsPerRun || b.left() < 10) { more = true; continue; }         // stays queued; the next run lists again
          const item = await kv.get(env, b, name);
          if (!item) continue;                                                                      // not visible yet (KV lag) or expired → next run
          taken++;
          if (!KINDS[item.k] || !Array.isArray(item.u)) { done[name] = now; continue; }
          newSrc.push({ id: name, f, k: item.k, at, u: item.u.filter(isId), x: textCopy(item) });
        }
      } catch (e) { rep.errors++; more = true; }                                                    // nothing marked → read again next time
    } else if (wantList) more = true;
    // 2b. reminders due in the last jobWindowMs (ids in `done` prevent repeats)
    for (const f of order) {
      if (!roomFor(f) || b.left() < 8 || (await okf(f)) !== true) continue;
      try {
        const doc = await kv.get(env, b, K.jobs(envName, f));
        for (const j of (doc && doc.jobs) || []) {
          const s = slotOf(j, f);
          if (!(s > to - LIMITS.jobWindowMs && s <= to)) continue;
          const id = `j:${f}:${j.k}:${s}:${hash32(j.u.join(",") + "|" + (j.g || "") + "|" + (j.t || "")).toString(36)}`;
          if (!done[id]) newSrc.push({ id, f, k: j.k, at: s, u: j.u, x: textCopy(j) });
        }
      } catch (e) { rep.errors++; }                                                                 // re-checked by the next runs (10-minute window)
    }
    // 2c. expand into device units (only active members' current devices)
    for (const src of newSrc) {
      let ctx; try { ctx = await famCtx(env, b, envName, src.f, cache); } catch (e) { continue; }    // not marked → taken in next run
      done[src.id] = now;
      if (!ctx) { rep.skipped += src.u.length; continue; }                                          // members list too old → fail closed
      for (const uid of new Set(src.u)) {
        const ru = ctx.roster.users[uid];
        if (!ru || !ru.a) { rep.skipped++; continue; }
        for (const s of (ctx.subs.list || {})[uid] || []) cand.push({ id: unitId(src.id, uid, s.endpoint), f: src.f, k: src.k, at: src.at, u: uid, e: s.endpoint, ...(src.x ? { x: src.x } : {}), pr: 3 });
      }
    }

    // 3. pick by device: primary first, then priority (dead run → retry → waiting → new), then oldest
    const seen = new Set(), valid = [];
    for (const u of cand.sort((x, y) => rank(x.f) - rank(y.f) || x.pr - y.pr || x.at - y.at)) {
      if (seen.has(u.id)) continue; seen.add(u.id);
      let ctx; try { ctx = await famCtx(env, b, envName, u.f, cache); } catch (e) { hold.wait.push(strip(u)); continue; }
      if (!subOf(ctx, u)) { rep.skipped++; continue; }                                              // device gone / person disabled meanwhile
      valid.push(u);
    }
    const chosen = [], rest = [];
    for (const u of valid) { if (chosen.length < cap && b.left() >= chosen.length + 1 + 2) chosen.push(u); else rest.push(u); }
    const wait = [...hold.wait, ...rest.map(strip)];
    if (wait.length > LIMITS.waitMax) rep.dropped += wait.length - LIMITS.waitMax;

    // 4. WRITE 1 — before anything is sent
    const next = { v: st.v, done, fly: [...hold.fly, ...chosen.map(u => ({ ...strip(u), r: run, t: now }))], retry: hold.retry, wait: wait.slice(0, LIMITS.waitMax), more };
    const changed = JSON.stringify([next.done, next.fly, next.retry, next.wait, next.more]) !== JSON.stringify([st.done, st.fly, st.retry, st.wait, st.more]);
    try { if (changed) await saveState(env, b, envName, next); } catch (e) { rep.errors++; continue; }
    rep.waiting += next.wait.length;
    if (!chosen.length) continue;

    // 5. send — one attempt per device
    const results = [];
    for (const u of chosen) {
      const ctx = cache[envName + "|" + u.f], s = subOf(ctx, u);
      let r = "skip";
      try { if (s) r = await pushOne(env, b, s, messageOf(u.k, u.x)); } catch (e) { r = "temp"; }       // out of budget → treated like a temporary failure
      pushesLeft--;
      results.push([u, r]);
      if (r === "ok") rep.sent++; else if (r === "skip") rep.skipped++; else rep.failed++;
      if (r === "gone") ctx.dead.push([u.u, u.e]);
    }
    // 6. WRITE 2 — confirm (if this fails the units stay in `fly` → re-sent later: duplicate, not loss)
    const mine = new Set(chosen.map(u => u.id));
    next.fly = next.fly.filter(u => !(u.r === run && mine.has(u.id)));
    for (const [u, r] of results) {
      if (r !== "temp") continue;
      const n = (u.n || 0) + 1;
      if (n >= LIMITS.retryMax || to - u.at > LIMITS.lateMs) { rep.dropped++; continue; }
      next.retry.push({ ...strip(u), n, next: now + LIMITS.retryDelayMs }); rep.retried++;
    }
    try { await saveState(env, b, envName, next); } catch (e) { rep.errors++; }
    for (const f of new Set(chosen.map(u => u.f))) {                                                // dead subscriptions (best effort)
      const ctx = cache[envName + "|" + f];
      if (!ctx || !ctx.dead.length || b.left() < 1) continue;
      const list = ctx.subs.list || {};
      for (const [uid, ep] of ctx.dead) { list[uid] = (list[uid] || []).filter(x => x.endpoint !== ep); if (!list[uid].length) delete list[uid]; }
      try { await kv.put(env, b, K.subs(envName, f), { ...ctx.subs, list }); rep.removed += ctx.dead.length; } catch (e) { rep.errors++; }
    }
  }
  if (Object.values(rep).some(Boolean)) console.log(JSON.stringify({ cron: new Date(to).toISOString(), ...rep }));   // counts only
  return rep;
}
function strip(u) { const { pr, r, t, ...x } = u; return x; }
/* only the three text fields, re-checked (items and plans were validated on the way in; this is defence in depth) */
function textCopy(o) {
  if (!o || typeof o.t !== "string" || !o.t) return null;
  const x = { t: o.t.slice(0, TEXT.title) };
  if (typeof o.b === "string" && o.b) x.b = o.b.slice(0, TEXT.body);
  if (typeof o.g === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(o.g)) x.g = o.g;
  return x;
}
export const _test = { resetMemory() { for (const k of Object.keys(MEM)) delete MEM[k]; } };   // tests only: simulate a fresh instance

export default {
  async fetch(req, env) {
    try { return await handle(req, env); }
    catch (e) {
      if (e instanceof Fail) return json({ error: e.code }, e.status);
      console.log(JSON.stringify({ error: "internal" }));                                          // no details: they could contain user data
      return json({ error: "internal" }, 500);
    }
  },
  async scheduled(event, env, ctx) { await runCron(env, event.scheduledTime || Date.now()); },
};
