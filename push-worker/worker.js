/* Nido push server — Cloudflare Worker, FREE plan only (no card, no paid add-ons).
   Sends Web Push notifications to family members' phones and fires scheduled reminders.

   Free-plan resources used (and nothing else):
     • Workers Free  — HTTP requests + 1 cron trigger ("* * * * *")
     • Workers KV    — one namespace bound as NIDO (free: 100k reads / 1k writes / 1 GB per day)
   No Durable Objects, no Queues, no D1, no R2, no paid features. If a free limit is hit, Cloudflare
   rejects the request — it never bills (and the account has no payment method anyway).

   FAMILY ISOLATION
   • Every POST carries the caller's Firebase ID token. The worker reads the caller's own profile
     (users/{uid}) from Firestore WITH that token — Firestore checks the token, so a forged token gets
     nothing. The family comes from that profile (server side), never from the request body.
   • All storage is keyed by environment AND family:
        subs:{env}:{fam}  = { uid: [subscription, …] }      who can receive, per family
        jobs:{env}:{fam}  = [ reminder, … ]                 that family's scheduled reminders
        dev:{endpointHash}= { env, fam, uid }               which family/user owns a device
        fams:{env}        = [ fam, … ]                      families that have reminders (for the cron)
     A caller can only read/write the keys of their own family, so they cannot subscribe to,
     overwrite, or send into another family. A uid from another family simply has no subscription
     in the caller's family bucket, so a message aimed at it reaches nobody.
   • The test environment is open only to the first family ("home"), same as the database rules.

   DUPLICATES & RETRIES
   • Reminders are minute-aligned. Each cron run sends exactly the jobs whose time falls inside its own
     minute (scheduledTime-60s, scheduledTime], so a reminder belongs to exactly one run — no "sent"
     list is needed (saves KV writes and avoids duplicates from KV's eventual consistency).
     A missed cron run means that reminder is skipped, never sent twice.
   • Each push gets one quick retry on a temporary error (429/5xx/network). Dead subscriptions
     (404/410) are removed. */
const PROJECT = "nido-family-72346";
const ORIGIN = "https://slavaborhovich.github.io";
const SUBJECT = "https://slavaborhovich.github.io/nido/";
const ENVS = ["prod", "test"];
const HOME = "home";
const MAX_DEVICES = 6, MAX_JOBS = 300, MAX_UIDS = 20;

const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const cors = { "Access-Control-Allow-Origin": ORIGIN, "Access-Control-Allow-Headers": "content-type, authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Max-Age": "86400" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...cors } });
const clean = s => String(s == null ? "" : s).slice(0, 300);
const safeId = s => /^[A-Za-z0-9_-]{1,64}$/.test(s || "") ? s : null;
const msgOf = b => ({ title: clean(b.title) || "Nido", body: clean(b.body), tag: clean(b.tag), tab: clean(b.tab) });
const K = {
  subs: (env, fam) => `subs:${env}:${fam}`,
  jobs: (env, fam) => `jobs:${env}:${fam}`,
  fams: env => `fams:${env}`,
  dev: h => `dev:${h}`,
};
async function sha(s) { return b64u(await crypto.subtle.digest("SHA-256", enc.encode(s))).slice(0, 32); }

/* ---------- VAPID keys: created once, kept in KV; the signing key is cached per isolate ---------- */
let VAPID = null, SIGNKEY = null; const JWT = new Map();
async function vapid(env) {
  if (VAPID) return VAPID;
  let v = await env.NIDO.get("vapid", "json");
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    v = { pub: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)), jwk: await crypto.subtle.exportKey("jwk", kp.privateKey) };
    await env.NIDO.put("vapid", JSON.stringify(v));
  }
  return VAPID = v;
}
async function vapidHeader(env, endpoint) {
  const aud = new URL(endpoint).origin, hit = JWT.get(aud);
  if (hit && hit.exp > Date.now() + 60e3) return hit.h;                          // re-use: fewer signatures = less CPU
  const v = await vapid(env);
  SIGNKEY = SIGNKEY || await crypto.subtle.importKey("jwk", v.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp, sub: SUBJECT })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, SIGNKEY, enc.encode(`${head}.${body}`));
  const h = `vapid t=${head}.${body}.${b64u(sig)}, k=${v.pub}`;
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
  return cat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub, ct);   // record size 4096
}
async function pushOne(env, sub, msg) {
  const send = async () => (await fetch(sub.endpoint, {
    method: "POST",
    headers: { TTL: "86400", Urgency: "high", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Authorization: await vapidHeader(env, sub.endpoint) },
    body: await encrypt(sub, JSON.stringify({ data: msg })),
  })).status;
  let st; try { st = await send(); } catch (e) { st = 0; }
  if (st === 0 || st === 429 || st >= 500) { await new Promise(r => setTimeout(r, 400)); try { st = await send(); } catch (e) { st = 0; } }   // one retry
  return st;
}

/* ---------- delivery: only inside one family's bucket ---------- */
async function deliver(env, envName, fam, uids, msg) {
  const key = K.subs(envName, fam);
  const subs = (await env.NIDO.get(key, "json")) || {};
  let dirty = false, sent = 0;
  for (const uid of new Set(uids)) {
    for (const s of [...(subs[uid] || [])]) {
      const st = await pushOne(env, s, msg);
      if (st === 404 || st === 410) { subs[uid] = subs[uid].filter(x => x.endpoint !== s.endpoint); if (!subs[uid].length) delete subs[uid]; dirty = true; }
      else if (st >= 200 && st < 300) sent++;
    }
  }
  if (dirty) await env.NIDO.put(key, JSON.stringify(subs));
  return sent;
}

/* ---------- who is calling, and which family are they in? (family comes from the database, not the request) ---------- */
const seen = new Map();
async function caller(req) {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!tok) return null;
  const hit = seen.get(tok); if (hit && hit.exp > Date.now()) return hit.who;
  let claims; try { claims = JSON.parse(new TextDecoder().decode(unb64u(tok.split(".")[1]))); } catch (e) { return null; }
  if (claims.aud !== PROJECT || !safeId(claims.user_id) || !(claims.exp * 1000 > Date.now())) return null;
  // Firestore verifies the token's signature; the database rules let a signed-in user read only their own profile here
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/users/${claims.user_id}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) return null;
  const f = (await r.json()).fields || {};
  if (!f.active || f.active.booleanValue !== true) return null;                   // disabled people / disabled families get nothing
  const fam = safeId(f.family && f.family.stringValue) || HOME;
  const who = { uid: claims.user_id, fam };
  seen.set(tok, { who, exp: Math.min(claims.exp * 1000, Date.now() + 10 * 60e3) });
  if (seen.size > 500) seen.clear();
  return who;
}

/* ---------- a device belongs to one user in one family; moving it removes it from the old place ---------- */
async function detach(env, ep) {
  const dk = K.dev(await sha(ep));
  const d = await env.NIDO.get(dk, "json");
  if (!d) return dk;
  const key = K.subs(d.env, d.fam), subs = (await env.NIDO.get(key, "json")) || {};
  let dirty = false;
  for (const u of Object.keys(subs)) {
    const keep = subs[u].filter(s => s.endpoint !== ep);
    if (keep.length !== subs[u].length) { dirty = true; if (keep.length) subs[u] = keep; else delete subs[u]; }
  }
  if (dirty) await env.NIDO.put(key, JSON.stringify(subs));
  await env.NIDO.delete(dk);
  return dk;
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path === "/vapid") return json({ key: (await vapid(env)).pub });
    if (req.method !== "POST") return json({ ok: true, service: "nido-push" });

    const who = await caller(req);
    if (!who) return json({ error: "unauthorized" }, 401);
    let b; try { b = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); }
    const envName = ENVS.includes(b.env) ? b.env : null;
    if (!envName) return json({ error: "bad env" }, 400);
    if (envName === "test" && who.fam !== HOME) return json({ error: "forbidden" }, 403);
    const { uid, fam } = who;

    if (path === "/subscribe") {
      const s = b.sub || {}, ep = clean(s.endpoint);
      if (!/^https:\/\//.test(ep) || !s.keys || !s.keys.p256dh || !s.keys.auth) return json({ error: "bad sub" }, 400);
      const dk = K.dev(await sha(ep)), cur = await env.NIDO.get(dk, "json");
      if (cur && cur.env === envName && cur.fam === fam && cur.uid === uid) return json({ ok: true, same: true });   // nothing to write
      await detach(env, ep);                                                       // the device left its old family/user
      const key = K.subs(envName, fam), subs = (await env.NIDO.get(key, "json")) || {};
      subs[uid] = [...(subs[uid] || []).filter(x => x.endpoint !== ep), { endpoint: ep, keys: { p256dh: clean(s.keys.p256dh), auth: clean(s.keys.auth) } }].slice(-MAX_DEVICES);
      await env.NIDO.put(key, JSON.stringify(subs));
      await env.NIDO.put(dk, JSON.stringify({ env: envName, fam, uid }));
      return json({ ok: true });
    }
    if (path === "/unsubscribe") {
      const ep = clean(b.endpoint); if (!ep) return json({ error: "no endpoint" }, 400);
      const d = await env.NIDO.get(K.dev(await sha(ep)), "json");
      if (d && !(d.fam === fam && d.uid === uid)) return json({ error: "forbidden" }, 403);   // only the device's own user
      await detach(env, ep);
      return json({ ok: true });
    }
    if (path === "/send") {                                                         // only into the caller's own family
      const uids = (Array.isArray(b.uids) ? b.uids : []).map(safeId).filter(Boolean).filter(x => x !== uid).slice(0, MAX_UIDS);
      return json({ ok: true, sent: uids.length ? await deliver(env, envName, fam, uids, msgOf(b)) : 0 });
    }
    if (path === "/test") return json({ ok: true, sent: await deliver(env, envName, fam, [uid], { title: "Nido 🔔", body: "ההתראות עובדות!", tag: "test", tab: "" }) });
    if (path === "/jobs") {                                                         // replaces only the caller's own family's reminders
      const now = Date.now();
      const jobs = (Array.isArray(b.jobs) ? b.jobs : []).slice(0, MAX_JOBS)
        .filter(j => j && j.id && +j.at > now && +j.at < now + 8 * 864e5)
        .map(j => ({ id: clean(j.id), at: Math.floor(+j.at / 60e3) * 60e3, uids: (j.uids || []).map(safeId).filter(Boolean).slice(0, MAX_UIDS), ...msgOf(j) }))
        .sort((a, c) => a.at - c.at || a.id.localeCompare(c.id));
      const key = K.jobs(envName, fam), next = JSON.stringify(jobs);
      if ((await env.NIDO.get(key)) !== next) await env.NIDO.put(key, next);       // every family member sends the same plan → write once
      const fams = (await env.NIDO.get(K.fams(envName), "json")) || [];
      if (!fams.includes(fam)) await env.NIDO.put(K.fams(envName), JSON.stringify([...fams, fam]));
      return json({ ok: true, jobs: jobs.length });
    }
    return json({ error: "not found" }, 404);
  },

  /* once a minute: each family's reminders that fall in this exact minute — no list of "already sent" needed */
  async scheduled(event, env) {
    const to = Math.floor((event.scheduledTime || Date.now()) / 60e3) * 60e3, from = to - 60e3;
    for (const envName of ENVS) {
      const fams = (await env.NIDO.get(K.fams(envName), "json")) || [];
      for (const fam of fams) {
        const jobs = (await env.NIDO.get(K.jobs(envName, fam), "json")) || [];
        for (const j of jobs) if (j.at > from && j.at <= to) await deliver(env, envName, fam, j.uids, msgOf(j));
      }
    }
  },
};
