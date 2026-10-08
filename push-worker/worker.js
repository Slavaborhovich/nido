/* Nido push server — Cloudflare Worker, FREE plan only (no card, no paid add-ons, nothing that bills).

   Uses only:  Workers Free (HTTP + 1 cron "* * * * *")  ·  one Workers KV namespace bound as NIDO.
   Secrets (set once with `wrangler secret put`, never in code/GitHub/Firestore): VAPID_PUBLIC, VAPID_PRIVATE.
   Free-plan limits this code is built around (see README.md for links):
     100k requests/day · 10 ms CPU per invocation · 50 subrequests per invocation (fetch + every KV call)
     KV: 100k reads · 1k writes · 1k deletes per day. Over a limit → errors, never charges.

   SECURITY
   • Every POST needs the caller's Firebase ID token. The worker reads the caller's OWN profile from Firestore
     with that token (Firestore verifies signature/issuer/audience/expiry). Family, role and active come from
     that profile — never from the request. No token cache: role/active are checked on every request.
   • Roles: viewers may only manage their own device (subscribe / unsubscribe / test). Only editors and
     admins may send notifications or replace the family's reminder plan.
   • Recipients are filtered against the family roster (users of the caller's family, read from Firestore with
     the caller's token, stored in KV as uid → {active, role}). Disabled/deleted users never get notifications.
   • All storage is keyed by env AND family; a caller can only touch their own family's keys.

   PRIVACY — notifications are generic. The client sends only a kind code (e.g. "task"); the text comes from
   the fixed table below. KV stores uids, times and kind codes — no names, titles, places, tasks or items.

   RELIABILITY
   • Reminders are minute-aligned and spread: each job is shifted by a stable offset (digests over 30 min,
     reminders over 3 min) so the morning summaries don't all land in one run.
   • Each run has a hard budget (subrequests and pushes). Jobs that don't fit are written to a small carry list
     BEFORE sending and sent by the next run. A crash mid-run can lose a notification, never duplicate one.
   • Each family is processed inside its own try/catch, in a rotating order, so one family's failure or size
     never blocks the others.
   • Dead subscriptions (404/410, or keys that can't be used) are removed; temporary errors (429/5xx/network)
     get at most one retry and the subscription is kept. */

const PROJECT = "nido-family-72346";
const ORIGIN = "https://slavaborhovich.github.io";
const SUBJECT = "https://slavaborhovich.github.io/nido/";
const ENVS = ["prod", "test"];
const HOME = "home";
const SUPER = "K2TaGlPsCJQ7W4HPdaOwQqvRKGS2";                    // the system admin (same as the database rules)

/* ---------- limits (conservative for the free plan) ---------- */
export const LIMITS = {
  bodyBytes: 16 * 1024,          // max request body
  uidsPerCall: 20,               // recipients per /send or per job
  jobsPerFamily: 120,            // reminders in a family's plan (7 days)
  devicesPerUser: 6,
  // daily KV write budgets (UTC day) — counted inside the values we write anyway, so they cost no extra writes
  planWritesPerFamily: 48, planWritesPerUser: 24,
  subWritesPerFamily: 30, subWritesPerUser: 10,
  rosterMaxAgeMs: 8 * 864e5,     // older roster → that family's scheduled notifications are skipped (fail closed)
  rosterRefreshMs: 6 * 3600e3,   // refresh the roster from Firestore at most this often (unless forced)
  // per invocation
  subreqBudget: 40,              // of 50 allowed
  pushesPerCron: 8,              // ≈ CPU-safe under 10 ms (≈0.6–0.9 ms crypto per push, measured locally)
  pushesPerSend: 10,
  sendsPerMinutePerUser: 6,      // in-memory, per worker instance only (best effort, not global)
  carryMax: 200,
  digestSpreadMin: 30, remindSpreadMin: 3,
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
  test:   { title: "🔔 NIDO — ההתראות עובדות!", tab: "" },
};
const BODY = "פתחו את NIDO כדי לראות";
const SEND_KINDS = ["task", "event", "idea", "shop", "note"];
const JOB_KINDS = ["remind", "digest"];
export const messageOf = kind => { const k = KINDS[kind]; return k ? { title: k.title, body: BODY, tag: kind, tab: k.tab } : null; };

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
const K = {
  subs: (e, f) => `subs:${e}:${f}`,      // { day, w:{uid:n}, n, list:{ uid:[sub,…] } }
  jobs: (e, f) => `jobs:${e}:${f}`,      // { day, w:{uid:n}, n, jobs:[{at,k,u:[uid]}] }
  roster: (e, f) => `roster:${e}:${f}`,  // { at, users:{ uid:{a:1|0, r:"admin"|"editor"|"viewer"} } }
  fams: e => `fams:${e}`,                // [fam, …]
  carry: e => `carry:${e}`,              // [{f, k, u, at}] — only written when a run overflows
  dev: h => `dev:${h}`,                  // { e, f, u }
};
class Fail extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

/* budget per invocation: every fetch and every KV call is a subrequest on the free plan */
function budget(limit = LIMITS.subreqBudget) {
  return { used: 0, pushes: 0, take(n = 1) { if (this.used + n > limit) throw new Fail(503, "busy"); this.used += n; }, left() { return limit - this.used; } };
}
const kv = {
  async get(env, b, key) { b.take(); try { return await env.NIDO.get(key, "json"); } catch (e) { throw new Fail(503, "storage"); } },
  async put(env, b, key, v) { b.take(); try { await env.NIDO.put(key, JSON.stringify(v)); } catch (e) { throw new Fail(503, "storage"); } },
  async del(env, b, key) { b.take(); try { await env.NIDO.delete(key); } catch (e) { throw new Fail(503, "storage"); } },
};
/* daily write counters live inside the value itself → enforcing the limit costs no extra writes */
function charge(doc, uid, perUser, perFamily) {
  const d = today();
  if (doc.day !== d) { doc.day = d; doc.w = {}; doc.n = 0; }
  if ((doc.n || 0) >= perFamily || ((doc.w || {})[uid] || 0) >= perUser) throw new Fail(429, "daily-limit");
  doc.n = (doc.n || 0) + 1; doc.w = { ...(doc.w || {}), [uid]: ((doc.w || {})[uid] || 0) + 1 };
}

/* ---------- VAPID (from secrets only — no key is ever generated at request time) ---------- */
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
/* result: "ok" | "gone" (remove) | "temp" (keep) | "error" (keep) */
async function pushOne(env, b, sub, msg) {
  let payload;
  try { payload = await encrypt(sub, JSON.stringify({ data: msg })); } catch (e) { return "gone"; }   // unusable keys: permanent
  const attempt = async () => {
    b.take();
    try {
      const r = await fetch(sub.endpoint, { method: "POST", headers: { TTL: "86400", Urgency: "normal", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Authorization: await vapidHeader(env, sub.endpoint) }, body: payload });
      return r.status;
    } catch (e) { return 0; }
  };
  b.pushes++;
  let st = await attempt();
  if ((st === 0 || st === 429 || st >= 500) && b.left() > 2) st = await attempt();               // one retry, only if budget allows
  if (st >= 200 && st < 300) return "ok";
  if (st === 404 || st === 410) return "gone";                                                    // RFC 8030: subscription expired/unsubscribed
  if (st === 0 || st === 429 || st >= 500) return "temp";
  return "error";                                                                                 // 400/401/403/413…: kept, logged by count
}

/* deliver to some uids inside ONE family; only active roster members; honest counts.
   A user is started only if the budget allows ALL their devices; users that don't fit are returned in `deferred`
   (so the cron can carry them to the next run without ever sending to a device twice). */
async function deliver(env, b, envName, fam, uids, kind, maxPushes, cache = {}) {
  const out = { sent: 0, failed: 0, skipped: 0, removed: 0, deferred: [] };
  const msg = messageOf(kind); if (!msg) return out;
  const rk = K.roster(envName, fam), sk = K.subs(envName, fam);
  const roster = rk in cache ? cache[rk] : (cache[rk] = await kv.get(env, b, rk));
  if (!roster || !(Date.now() - roster.at < LIMITS.rosterMaxAgeMs)) { out.skipped = uids.length; return out; }   // fail closed
  const doc = sk in cache ? cache[sk] : (cache[sk] = await kv.get(env, b, sk));
  if (!doc || !doc.list) return out;
  const dead = [];
  for (const uid of new Set(uids)) {
    const u = roster.users[uid];
    if (!u || !u.a) { out.skipped++; continue; }                                                   // disabled / deleted / not in family
    const devs = doc.list[uid] || [];
    if (!devs.length) continue;
    if (b.pushes + devs.length > maxPushes || b.left() < devs.length * 2 + 2) { out.deferred.push(uid); continue; }
    for (const s of devs) {
      const r = await pushOne(env, b, s, msg);
      if (r === "ok") out.sent++; else out.failed++;
      if (r === "gone") dead.push([uid, s.endpoint]);
    }
  }
  if (dead.length && b.left() >= 1) {
    for (const [uid, ep] of dead) { doc.list[uid] = (doc.list[uid] || []).filter(x => x.endpoint !== ep); if (!doc.list[uid].length) delete doc.list[uid]; }
    await kv.put(env, b, sk, doc); out.removed = dead.length;
  }
  return out;
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
  let r; try { r = await fetch(`${FS}/users/${claims.user_id}`, { headers: { Authorization: `Bearer ${tok}` } }); } catch (e) { throw new Fail(503, "auth-unavailable"); }
  if (!r.ok) return null;
  const f = (await r.json()).fields || {};
  if (!f.active || f.active.booleanValue !== true) return null;                                   // disabled people and disabled families
  const role = f.role && f.role.stringValue;
  if (!["admin", "editor", "viewer"].includes(role)) return null;
  const fam = isId(f.family && f.family.stringValue) ? f.family.stringValue : HOME;
  return { uid: claims.user_id, fam, role, tok, isSuper: claims.user_id === SUPER };
}
/* the family's members (uid → active/role), read with the caller's token — the rules decide what they may list */
async function fetchRoster(b, who, fam) {
  b.take();
  let r;
  try {
    r = await fetch(`${FS}:runQuery`, { method: "POST", headers: { Authorization: `Bearer ${who.tok}`, "content-type": "application/json" },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "users" }], where: { fieldFilter: { field: { fieldPath: "family" }, op: "EQUAL", value: { stringValue: fam } } }, limit: 100 } }) });
  } catch (e) { throw new Fail(503, "roster-unavailable"); }
  if (!r.ok) throw new Fail(r.status === 403 ? 403 : 503, "roster");
  const users = {};
  for (const row of await r.json()) {
    const d = row.document; if (!d) continue;
    const uid = d.name.split("/").pop(), f = d.fields || {};
    if (!isId(uid)) continue;
    users[uid] = { a: f.active && f.active.booleanValue === true ? 1 : 0, r: (f.role && f.role.stringValue) || "viewer" };
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
    if (!Object.keys(users).length) {                                                              // a family that no longer exists
      for (const k of [K.subs(envName, fam), K.jobs(envName, fam), K.roster(envName, fam)]) await kv.del(env, b, k);
      const fams = (await kv.get(env, b, K.fams(envName))) || [];
      if (fams.includes(fam)) await kv.put(env, b, K.fams(envName), fams.filter(x => x !== fam));
    }
  }
  return next;
}

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
  const who = await caller(req, b);
  if (!who) return json({ error: "unauthorized" }, 401);
  if (envName === "test" && who.fam !== HOME) throw new Fail(403, "forbidden");
  const { uid, fam, role } = who, canEdit = role === "admin" || role === "editor";

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
  if (path === "/test") {
    if (!throttle(`t:${uid}`, 3)) throw new Fail(429, "slow-down");
    await syncRoster(env, b, envName, who, fam, false);
    const r = await deliver(env, b, envName, fam, [uid], "test", LIMITS.pushesPerSend);
    return json({ ok: r.sent > 0 && r.failed === 0, sent: r.sent, failed: r.failed, skipped: r.skipped, removed: r.removed });
  }
  if (path === "/send") {
    if (!canEdit) throw new Fail(403, "read-only");
    if (!SEND_KINDS.includes(body.kind)) throw new Fail(400, "bad-kind");
    const uids = uidList(body.uids, LIMITS.uidsPerCall).filter(x => x !== uid);
    if (!throttle(`s:${uid}`, LIMITS.sendsPerMinutePerUser)) throw new Fail(429, "slow-down");
    if (!uids.length) return json({ ok: true, sent: 0 });
    await syncRoster(env, b, envName, who, fam, false);
    const r = await deliver(env, b, envName, fam, uids, body.kind, LIMITS.pushesPerSend);
    return json({ ok: r.failed === 0 && r.skipped === 0 && r.deferred.length === 0, sent: r.sent, failed: r.failed, skipped: r.skipped + r.deferred.length, removed: r.removed });
  }
  if (path === "/jobs") {
    if (!canEdit) throw new Fail(403, "read-only");
    if (!Array.isArray(body.jobs) || body.jobs.length > LIMITS.jobsPerFamily) throw new Fail(400, "bad-jobs");
    const now = Date.now(), jobs = [];
    for (const j of body.jobs) {
      if (!j || typeof j !== "object" || !JOB_KINDS.includes(j.kind) || typeof j.at !== "number" || !isFinite(j.at)) throw new Fail(400, "bad-job");
      if (!(j.at > now && j.at < now + 8 * 864e5)) continue;                                        // past or too far: ignored
      jobs.push({ at: Math.floor(j.at / 60e3) * 60e3, k: j.kind, u: uidList(j.uids, LIMITS.uidsPerCall) });
    }
    const roster = await syncRoster(env, b, envName, who, fam, false);
    const clean = jobs.map(j => ({ ...j, u: j.u.filter(x => roster.users[x] && roster.users[x].a) })).filter(j => j.u.length)
      .sort((a, c) => a.at - c.at || a.k.localeCompare(c.k) || a.u.join().localeCompare(c.u.join()));
    const key = K.jobs(envName, fam), doc = (await kv.get(env, b, key)) || {};
    if (JSON.stringify(doc.jobs || []) === JSON.stringify(clean)) return json({ ok: true, jobs: clean.length, same: true });   // every member sends the same plan → write once
    charge(doc, uid, LIMITS.planWritesPerUser, LIMITS.planWritesPerFamily);
    doc.jobs = clean;
    await kv.put(env, b, key, doc);
    const fams = (await kv.get(env, b, K.fams(envName))) || [];
    if (!fams.includes(fam)) await kv.put(env, b, K.fams(envName), [...fams, fam]);
    return json({ ok: true, jobs: clean.length });
  }
  if (path === "/roster") {                                                                         // after an admin disables / deletes / changes someone
    let target = fam;
    if (body.fam !== undefined) { if (!isId(body.fam)) throw new Fail(400, "bad-fam"); target = body.fam; }
    if (target !== fam && !who.isSuper) throw new Fail(403, "forbidden");                           // only the system admin may refresh another family
    if (role !== "admin" && !who.isSuper) throw new Fail(403, "forbidden");
    const r = await syncRoster(env, b, envName, who, target, true);
    return json({ ok: true, members: Object.keys(r.users || {}).length });
  }
  throw new Fail(404, "not-found");
}

/* ================= CRON =================
   Per env: read the family list and the carry list, collect this minute's due jobs per family (each family in its
   own try/catch, rotating order), decide what fits this run's budget, write the rest to `carry` BEFORE sending,
   send, then append users that were deferred mid-send. Old carried items (> 30 min) are dropped, not sent late. */
export async function runCron(env, scheduledTime) {
  const report = { sent: 0, failed: 0, skipped: 0, carried: 0, dropped: 0, familyErrors: 0 };
  if (!vapidReady(env)) return report;
  const to = Math.floor(scheduledTime / 60e3) * 60e3, from = to - 60e3;
  for (const envName of ENVS) {
    const b = budget(), cache = {};
    let fams = [], carry = [];
    try { fams = (await kv.get(env, b, K.fams(envName))) || []; carry = (await kv.get(env, b, K.carry(envName))) || []; }
    catch (e) { report.familyErrors++; continue; }
    const start = fams.length ? Math.floor(to / 60e3) % fams.length : 0;
    const order = [...fams.slice(start), ...fams.slice(0, start)];
    const due = [], rescan = [];
    // 1. carried work: deliveries, and minute-windows of families that couldn't be scanned in time
    for (const c of carry) {
      if (!order.includes(c.f)) continue;
      if (c.scan) { rescan.push(c); continue; }
      if (to - c.at > 30 * 60e3) { report.dropped++; continue; }
      due.push(c);
    }
    // 2. scan each family's plan for this minute (plus any windows carried over)
    const windows = fam => [[from, to], ...rescan.filter(r => r.f === fam).map(r => [r.from, r.to])];
    const unscanned = [];
    for (const fam of order) {
      if (b.left() < 6) { for (const [a, z] of windows(fam)) unscanned.push({ f: fam, scan: 1, from: a, to: z }); continue; }
      try {
        const doc = await kv.get(env, b, K.jobs(envName, fam));
        for (const j of (doc && doc.jobs) || []) {
          const s = slotOf(j, fam);
          if (windows(fam).some(([a, z]) => s > a && s <= z) && to - s <= 30 * 60e3) due.push({ f: fam, k: j.k, u: j.u, at: s });
        }
      } catch (e) { report.familyErrors++; }
    }
    // 3. what fits now (by recipients; devices are re-checked inside deliver)
    const now = [], later = [];
    let users = 0;
    for (const d of due) { if (users + d.u.length <= LIMITS.pushesPerCron) { now.push(d); users += d.u.length; } else later.push(d); }
    const nextCarry = [...unscanned, ...later].slice(0, LIMITS.carryMax);
    report.dropped += Math.max(0, unscanned.length + later.length - nextCarry.length);
    // 4. record the carry BEFORE sending — if we can't, send nothing (never risk a duplicate)
    try {
      if (JSON.stringify(nextCarry) !== JSON.stringify(carry)) {
        if (nextCarry.length) await kv.put(env, b, K.carry(envName), nextCarry); else await kv.del(env, b, K.carry(envName));
      }
    } catch (e) { report.familyErrors++; continue; }
    report.carried += nextCarry.length;
    // 5. send; each delivery isolated
    const deferred = [];
    for (const d of now) {
      try {
        const r = await deliver(env, b, envName, d.f, d.u, d.k, LIMITS.pushesPerCron, cache);
        report.sent += r.sent; report.failed += r.failed; report.skipped += r.skipped;
        if (r.deferred.length) deferred.push({ ...d, u: r.deferred });
      } catch (e) { report.familyErrors++; }
    }
    if (deferred.length) {
      try { const all = [...nextCarry, ...deferred].slice(0, LIMITS.carryMax); await kv.put(env, b, K.carry(envName), all); report.carried += deferred.length; }
      catch (e) { report.dropped += deferred.length; }                                            // reported, not silently lost
    }
  }
  if (report.sent || report.failed || report.skipped || report.carried || report.dropped || report.familyErrors)
    console.log(JSON.stringify({ cron: new Date(to).toISOString(), ...report }));                  // counts only — no tokens, uids or content
  return report;
}

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
