/* Nido push server — Cloudflare Worker (free plan).
   Sends Web Push notifications to the family's phones and fires scheduled reminders.
   Storage: one KV namespace bound as NIDO.
   Security: every call must carry the caller's Firebase ID token; the worker asks Firestore
   for the caller's own profile with that token, so only active family members get through. */
const PROJECT = "nido-family-72346";
const ORIGIN = "https://slavaborhovich.github.io";
const SUBJECT = "https://slavaborhovich.github.io/nido/";
const ENVS = ["prod", "test"];

const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const cors = { "Access-Control-Allow-Origin": ORIGIN, "Access-Control-Allow-Headers": "content-type, authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Max-Age": "86400" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...cors } });

/* ---------- VAPID keys: created once, kept in KV ---------- */
async function vapid(env) {
  let v = await env.NIDO.get("vapid", "json");
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    v = { pub: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)), jwk: await crypto.subtle.exportKey("jwk", kp.privateKey) };
    await env.NIDO.put("vapid", JSON.stringify(v));
  }
  return v;
}
async function vapidHeader(env, endpoint) {
  const v = await vapid(env);
  const key = await crypto.subtle.importKey("jwk", v.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${v.pub}`;
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
  const rs = new Uint8Array([0, 0, 16, 0]);                                         // record size 4096
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
async function pushOne(env, sub, msg) {
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: { TTL: "86400", Urgency: "high", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Authorization: await vapidHeader(env, sub.endpoint) },
    body: await encrypt(sub, JSON.stringify({ data: msg })),
  });
  return res.status;
}

/* ---------- subscriptions: subs:{env} = { uid: [subscription, ...] } ---------- */
async function deliver(env, envName, uids, msg) {
  const subs = (await env.NIDO.get(`subs:${envName}`, "json")) || {};
  let dirty = false, sent = 0;
  for (const uid of new Set(uids)) {
    const list = subs[uid] || [];
    for (const s of [...list]) {
      try {
        const st = await pushOne(env, s, msg);
        if (st === 404 || st === 410) { subs[uid] = subs[uid].filter(x => x.endpoint !== s.endpoint); dirty = true; }
        else if (st < 300) sent++;
      } catch (e) { /* network hiccup — skip */ }
    }
  }
  if (dirty) await env.NIDO.put(`subs:${envName}`, JSON.stringify(subs));
  return sent;
}

/* ---------- who is calling? ---------- */
const seen = new Map();
async function member(req) {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!tok) return null;
  const hit = seen.get(tok); if (hit && hit.exp > Date.now()) return hit.uid;
  let claims; try { claims = JSON.parse(new TextDecoder().decode(unb64u(tok.split(".")[1]))); } catch (e) { return null; }
  if (claims.aud !== PROJECT || !claims.user_id) return null;
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/users/${claims.user_id}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) return null;
  const doc = await r.json();
  if (doc.fields && doc.fields.active && doc.fields.active.booleanValue === false) return null;
  seen.set(tok, { uid: claims.user_id, exp: Math.min(claims.exp * 1000, Date.now() + 30 * 60e3) });
  return claims.user_id;
}

const clean = s => String(s == null ? "" : s).slice(0, 300);
const msgOf = b => ({ title: clean(b.title) || "Nido", body: clean(b.body), tag: clean(b.tag), tab: clean(b.tab) });

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path === "/vapid") return json({ key: (await vapid(env)).pub });
    if (req.method !== "POST") return json({ ok: true, service: "nido-push" });

    const uid = await member(req);
    if (!uid) return json({ error: "unauthorized" }, 401);
    let b; try { b = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); }
    const envName = ENVS.includes(b.env) ? b.env : null;
    if (!envName) return json({ error: "bad env" }, 400);

    if (path === "/subscribe" || path === "/unsubscribe") {
      const subs = (await env.NIDO.get(`subs:${envName}`, "json")) || {};
      const ep = path === "/subscribe" ? b.sub && b.sub.endpoint : b.endpoint;
      if (!ep) return json({ error: "no endpoint" }, 400);
      for (const k of Object.keys(subs)) subs[k] = subs[k].filter(s => s.endpoint !== ep);      // one owner per device
      if (path === "/subscribe") {
        if (!b.sub.keys || !b.sub.keys.p256dh || !b.sub.keys.auth) return json({ error: "bad sub" }, 400);
        subs[uid] = [...(subs[uid] || []), { endpoint: ep, keys: { p256dh: b.sub.keys.p256dh, auth: b.sub.keys.auth } }].slice(-6);
      }
      await env.NIDO.put(`subs:${envName}`, JSON.stringify(subs));
      return json({ ok: true });
    }
    if (path === "/send") {
      const uids = (Array.isArray(b.uids) ? b.uids : []).slice(0, 20);
      return json({ ok: true, sent: await deliver(env, envName, uids, msgOf(b)) });
    }
    if (path === "/test") return json({ ok: true, sent: await deliver(env, envName, [uid], { title: "Nido 🔔", body: "ההתראות עובדות!", tag: "test", tab: "" }) });
    if (path === "/jobs") {
      const jobs = (Array.isArray(b.jobs) ? b.jobs : []).slice(0, 300)
        .filter(j => j && j.id && +j.at > 0)
        .map(j => ({ id: clean(j.id), at: +j.at, uids: (j.uids || []).slice(0, 20).map(clean), ...msgOf(j) }));
      await env.NIDO.put(`jobs:${envName}`, JSON.stringify(jobs));
      return json({ ok: true, jobs: jobs.length });
    }
    return json({ error: "not found" }, 404);
  },

  /* every minute: send reminders that are due */
  async scheduled(event, env) {
    const now = Date.now();
    for (const envName of ENVS) {
      const jobs = (await env.NIDO.get(`jobs:${envName}`, "json")) || [];
      const due = jobs.filter(j => j.at <= now && j.at > now - 30 * 60e3);
      if (!due.length) continue;
      const sent = (await env.NIDO.get(`sent:${envName}`, "json")) || {};
      let changed = false;
      for (const j of due) {
        if (sent[j.id]) continue;
        sent[j.id] = now; changed = true;
        await deliver(env, envName, j.uids, msgOf(j));
      }
      if (changed) {
        for (const k of Object.keys(sent)) if (sent[k] < now - 3 * 864e5) delete sent[k];
        await env.NIDO.put(`sent:${envName}`, JSON.stringify(sent));
      }
    }
  },
};
