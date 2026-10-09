// Local tests for the Nido push worker — mocks only: no network, no Cloudflare, no Firebase, no real phones.
// Run: node push-worker/test/worker.test.mjs
// What these tests CANNOT show (needs a real deployment): Cloudflare CPU time, real KV propagation delays, whether
// Cloudflare ever starts two cron runs for one minute, real delivery to Android, how a duplicate sounds on a phone.
import W, { runCron, LIMITS, KINDS, messageOf, slotOf, allowed, TEXT, _test } from "../worker.js";
import { readFileSync } from "node:fs";

let failures = 0, passed = 0;
const ok = (c, m) => { console.log((c ? "  ✔ " : "  ✘ FAIL ") + m); if (c) passed++; else failures++; };
const section = t => console.log("\n" + t);
const log0 = console.log; console.log = (...a) => { if (typeof a[0] === "string" && a[0].startsWith('{"cron"')) return; log0(...a); };

/* ---------- fake clock (the worker reads Date.now) ---------- */
let CLOCK = Date.UTC(2026, 9, 12, 6, 0, 0);
Date.now = () => CLOCK;
const advance = ms => { CLOCK += ms; };

/* ---------- KV simulator ----------
   • list() with prefix + expirationTtl, like Workers KV
   • stale reads: staleNext.add(key) → the next get of that key returns the PREVIOUS value (propagation lag)
   • hideInList.add(key) → the next list() doesn't show it yet (lists lag too)
   • interleaving: every operation yields to the event loop (randomized when JITTER is on) so concurrent calls mix
   • crash: crashAfter = n → after n more operations every operation hangs forever (the invocation "dies")
   • faults: a key (or "PUT") that throws */
const store = new Map(); const prev = new Map(); const faults = new Set(); const staleNext = new Set(); const hideInList = new Set();
let ops = 0, crashAfter = Infinity, JITTER = false, seed = 1;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const reads = [], writes = [];
const pause = () => new Promise(r => JITTER ? setTimeout(r, Math.floor(rnd() * 3)) : setImmediate(r));
const HANG = () => new Promise(() => {});
async function step() { ops++; if (--crashAfter < 0) return HANG(); await pause(); }
const live = k => { const e = store.get(k); if (!e) return null; if (e.exp && e.exp <= CLOCK) { store.delete(k); return null; } return e; };
const KV = {
  async get(k, t) {
    await step(); reads.push(k); if (faults.has(k)) throw new Error("kv down");
    if (staleNext.has(k)) { staleNext.delete(k); const p = prev.get(k); return p == null ? null : JSON.parse(p); }
    const e = live(k); return e == null ? null : (t === "json" ? JSON.parse(e.v) : e.v);
  },
  async put(k, v, opt = {}) {
    await step(); writes.push(k); if (faults.has("PUT") || faults.has("PUT:" + k)) throw new Error("kv write failed");
    const e = live(k); prev.set(k, e ? e.v : null);
    store.set(k, { v, exp: opt.expirationTtl ? CLOCK + opt.expirationTtl * 1000 : 0 });
  },
  async delete(k) { await step(); writes.push(k); prev.set(k, live(k) ? store.get(k).v : null); store.delete(k); },
  async list({ prefix, limit }) {
    await step(); reads.push("LIST " + prefix); if (faults.has("LIST")) throw new Error("kv down");
    const keys = [...store.keys()].filter(k => k.startsWith(prefix) && live(k) && !hideInList.has(k)).sort().slice(0, limit).map(name => ({ name }));
    hideInList.clear(); return { keys, list_complete: true };
  },
};
const getJ = k => { const e = live(k); return e ? JSON.parse(e.v) : null; };
const vapid = await (async () => {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  return { pub: Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64url"), d: (await crypto.subtle.exportKey("jwk", kp.privateKey)).d };
})();
const env = { NIDO: KV, VAPID_PUBLIC: vapid.pub, VAPID_PRIVATE: vapid.d };

/* ---------- mock Firestore (applies the same read rules as firestore.rules) + push services ---------- */
const PROJECT = "nido-family-72346", SUPER = "K2TaGlPsCJQ7W4HPdaOwQqvRKGS2";
const USERS = {
  [SUPER]: { family: "home", role: "admin", active: true },                           // the system admin (Slava)
  wife: { family: "home", role: "editor", active: true },
  kid: { family: "home", role: "viewer", active: true },
  off: { family: "home", role: "editor", active: false },
  b1: { family: "fB", role: "admin", active: true }, b2: { family: "fB", role: "editor", active: true },
  c1: { family: "fC", role: "editor", active: true },
};
const FAMDB = { home: { push: true }, fB: { push: false }, fC: { push: false } };       // only our family is enabled
let fsDown = false, famDown = false;
const fsVal = v => typeof v === "boolean" ? { booleanValue: v } : { stringValue: String(v) };
const famFields = f => Object.fromEntries(Object.entries(f).filter(([k]) => k === "push" || k === "active").map(([k, v]) => [k, fsVal(v)]));
const tok = (uid, { sig = "good", aud = PROJECT, exp = 3600 } = {}) => "h." + Buffer.from(JSON.stringify({ aud, iss: `https://securetoken.google.com/${aud}`, sub: uid, user_id: uid, exp: Math.floor(CLOCK / 1000) + exp })).toString("base64url") + "." + sig;
const pushed = []; let fetches = 0; const pushStatus = {};                           // name → [status, status…] (consumed in order)
globalThis.fetch = async (url, opt = {}) => {
  await step(); fetches++;
  url = String(url);
  if (url.includes("firestore.googleapis.com")) {
    if (fsDown) throw new Error("network");
    const t = (opt.headers.Authorization || "").replace("Bearer ", "");
    const claims = JSON.parse(Buffer.from(t.split(".")[1], "base64url"));
    if (!t.endsWith(".good") || claims.exp * 1000 < CLOCK || claims.aud !== PROJECT) return new Response("{}", { status: 401 });
    const me = USERS[claims.user_id], isSuper = claims.user_id === SUPER;
    if (url.includes("/documents/families")) {
      if (famDown) throw new Error("network");
      const rest = url.split("/documents/families")[1];
      if (rest.startsWith("?")) {
        if (!isSuper) return new Response("{}", { status: 403 });
        return new Response(JSON.stringify({ documents: Object.entries(FAMDB).map(([id, f]) => ({ name: `x/families/${id}`, fields: famFields(f) })) }), { status: 200 });
      }
      const fid = rest.slice(1);
      if (!isSuper && !(me && me.active && (me.family || "home") === fid)) return new Response("{}", { status: 403 });
      if (!FAMDB[fid]) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ name: `x/families/${fid}`, fields: famFields(FAMDB[fid]) }), { status: 200 });
    }
    if (url.endsWith(":runQuery")) {
      const fam = JSON.parse(opt.body).structuredQuery.where.fieldFilter.value.stringValue;
      if (!me || (!isSuper && (!me.active || me.family !== fam))) return new Response("[]", { status: 403 });
      return new Response(JSON.stringify(Object.entries(USERS).filter(([, u]) => u.family === fam).map(([uid, u]) => ({ document: { name: `x/users/${uid}`, fields: { active: { booleanValue: u.active }, role: { stringValue: u.role }, family: { stringValue: u.family }, ...(u.notif ? { notif: { mapValue: { fields: Object.fromEntries(Object.entries(u.notif).map(([k, v]) => [k, { booleanValue: v }])) } } } : {}) } } }))), { status: 200 });
    }
    const uid = url.split("/users/")[1];
    if (uid !== claims.user_id || !USERS[uid]) return new Response("{}", { status: uid !== claims.user_id ? 403 : 404 });
    const u = USERS[uid], fields = { active: { booleanValue: u.active }, role: { stringValue: u.role } };
    if (u.family !== undefined) fields.family = { stringValue: u.family };
    return new Response(JSON.stringify({ fields }), { status: 200 });
  }
  if (url.startsWith("https://push.test/")) {
    const name = url.split("/").pop();
    const q = pushStatus[name], st = q && q.length ? q.shift() : (name.startsWith("gone") ? 410 : name.startsWith("bad") ? 400 : 201);
    if (st === 0) throw new Error("network");
    pushed.push({ name, body: new Uint8Array(await new Response(opt.body).arrayBuffer()), st });
    return new Response("", { status: st });
  }
  throw new Error("unexpected fetch " + url);
};
const delivered = () => pushed.filter(p => p.st >= 200 && p.st < 300).map(p => p.name);

/* ---------- devices with real keys, so payloads can be decrypted ---------- */
const DEV = {};
async function device(name) {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub = { endpoint: "https://push.test/" + name, keys: { p256dh: Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64url"), auth: Buffer.from(auth).toString("base64url") } };
  DEV[name] = { kp, auth, sub }; return sub;
}
async function decrypt(name, body) {                                                     // RFC 8291 receiver side
  const { kp, auth } = DEV[name], enc = new TextEncoder();
  const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  const uaPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, kp.privateKey, 256));
  const hk = async (s, ikm, info, len) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), len * 8));
  const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
  const ikm = await hk(auth, secret, cat(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const cek = await hk(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16), nonce = await hk(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), ct));
  return JSON.parse(new TextDecoder().decode(pt.slice(0, pt.lastIndexOf(2))));
}

/* ---------- helpers: every invocation is checked against the 30-subrequest budget ---------- */
let maxSubreq = 0, maxPushesPerRun = 0, maxTestPushesPerRun = 0;
async function call(uid, path, body = {}, opts = {}) {
  const o0 = ops;
  const headers = { "content-type": "application/json" };
  if (uid) headers.authorization = "Bearer " + (opts.token || tok(uid));
  const raw = opts.raw !== undefined ? opts.raw : JSON.stringify({ env: "prod", ...body });
  const r = await W.fetch(new Request("https://worker.test/" + path.replace(/^\//, ""), { method: "POST", headers, body: raw }), env);
  maxSubreq = Math.max(maxSubreq, ops - o0);
  return { status: r.status, json: await r.json(), cors: r.headers.get("access-control-allow-origin") };
}
async function cron(t = CLOCK) {
  CLOCK = Math.max(CLOCK, t);
  const o0 = ops, p0 = pushed.length, r = await runCron(env, t);
  maxSubreq = Math.max(maxSubreq, ops - o0);
  maxPushesPerRun = Math.max(maxPushesPerRun, pushed.length - p0);
  return r;
}
async function minutes(n, from = CLOCK) { const reps = []; for (let i = 1; i <= n; i++) { CLOCK = from + i * 60e3; reps.push(await cron(CLOCK)); } return reps; }
const sum = (reps, k) => reps.reduce((a, r) => a + (r[k] || 0), 0);
const subsOf = (e, f) => (getJ(`subs:${e}:${f}`) || { list: {} }).list;
const queueKeys = (e = "prod") => [...store.keys()].filter(k => k.startsWith(`q:${e}:`) && live(k));
const count = (arr, x) => arr.filter(y => y === x).length;
function resetWorld() { for (const k of [...store.keys()]) if (/^(q|qhint|cron|jobs):/.test(k)) store.delete(k); pushed.length = 0; _test.resetMemory(); staleNext.clear(); hideInList.clear(); faults.clear(); crashAfter = Infinity; JITTER = false; }

/* =============================== tests =============================== */
section("Setup — our family enabled, the others disabled");
let r = await call(SUPER, "/policy");
ok(r.status === 200 && r.json.primary === "home" && JSON.stringify(r.json.allow) === '["home"]', `system admin sync: primary = his profile's family, allowed = ${JSON.stringify(r.json.allow)}`);
ok((await call(SUPER, "/subscribe", { sub: await device("S1") })).status === 200, "Slava's phone subscribes");
ok((await call("wife", "/subscribe", { sub: await device("W1") })).status === 200, "his wife's phone subscribes");
ok((await call("b1", "/subscribe", { sub: await device("B1") })).json.error === "push-off", "a disabled family cannot subscribe");
ok((await call(SUPER, "/subscribe", { sub: DEV.S1.sub })).json.same === true, "re-subscribing the same device writes nothing");

section("Authentication and roles");
ok((await call("wife", "/send", { uids: [SUPER], kind: "task" }, { token: tok("wife", { sig: "forged" }) })).status === 401, "forged token rejected");
ok((await call("wife", "/send", { uids: [SUPER], kind: "task" }, { token: tok("wife", { exp: -10 }) })).status === 401, "expired token rejected");
ok((await call("wife", "/send", { uids: [SUPER], kind: "task" }, { token: tok("wife", { aud: "other" }) })).status === 401, "token for another project rejected");
ok((await call(null, "/send", { uids: [SUPER], kind: "task" })).status === 401, "no token rejected");
ok((await call("off", "/subscribe", { sub: await device("OFF") })).status === 401, "disabled user rejected");
ok((await call("kid", "/send", { uids: [SUPER], kind: "task" })).status === 403, "viewer cannot send");
ok((await call("kid", "/jobs", { jobs: [{ at: CLOCK + 9e5, uids: [SUPER], kind: "remind" }] })).status === 403, "viewer cannot change the reminder plan");
ok((await call("wife", "/roster")).status === 403, "an editor cannot force a roster refresh");
ok((await call("wife", "/policy")).status === 403 && (await call("b1", "/policy", { fam: "fB" })).status === 403, "only the system admin may use /policy");

section("Queue only: /send and /test never push directly");
resetWorld();
let f0 = fetches;
r = await call("wife", "/send", { uids: [SUPER], kind: "task" });
ok(r.status === 200 && r.json.queued === 1 && pushed.length === 0, `/send answers "queued" and pushes nothing (${JSON.stringify(r.json)})`);
r = await call(SUPER, "/test");
ok(r.json.queued === 1 && pushed.length === 0, "/test is queued too");
ok(queueKeys().length === 2 && getJ("qhint:prod").t === CLOCK, "two separate queue items + a hint");
await minutes(1);
ok(delivered().sort().join() === "S1,S1", `the cron delivered both (${delivered().join()})`);
const msg = await decrypt("S1", pushed[0].body);
ok(Object.values(KINDS).some(k => k.title === msg.data.title), `without text the payload is the fixed generic text: "${msg.data.title}"`);
await minutes(1);

section("Cross-family isolation");
resetWorld();
r = await call("wife", "/send", { uids: [SUPER, "b1", "b2", "c1"], kind: "task" });
ok(r.json.queued === 1 && r.json.skipped === 3, "only members of the caller's own family are queued");
await minutes(1);
ok(delivered().join() === "S1", `…and only they receive it (${delivered().join()})`);
ok((await call("b1", "/send", { env: "test", uids: ["b2"], kind: "task" })).status === 403, "other families cannot use the test environment");
ok((await call("b1", "/roster", { fam: "home" })).status === 403, "a family admin cannot refresh another family");
ok((await call("b1", "/unsubscribe", { endpoint: DEV.S1.sub.endpoint })).status === 403, "cannot unsubscribe another family's device");
await call("wife", "/jobs", { fam: "fB", jobs: [{ at: CLOCK + 9e5, uids: ["wife"], kind: "remind" }] });
ok(!live("jobs:prod:fB"), "a 'fam' field in the request is ignored");

section("Invalid input (rejected safely, CORS kept)");
const bad = [
  ["bad json", await call("wife", "/send", {}, { raw: "{not json" })],
  ["array body", await call("wife", "/send", {}, { raw: "[1,2]" })],
  ["too large", await call("wife", "/send", {}, { raw: JSON.stringify({ env: "prod", pad: "x".repeat(20000) }) })],
  ["uids as string", await call("wife", "/send", { uids: SUPER, kind: "task" })],
  ["bad uid", await call("wife", "/send", { uids: ["../x"], kind: "task" })],
  ["too many uids", await call("wife", "/send", { uids: Array.from({ length: 30 }, (_, i) => "u" + i), kind: "task" })],
  ["unknown kind", await call("wife", "/send", { uids: [SUPER], kind: "free-text" })],
  ["bad env", await call("wife", "/send", { env: "staging", uids: [SUPER], kind: "task" })],
  ["bad subscription", await call("wife", "/subscribe", { sub: { endpoint: "http://x", keys: {} } })],
  ["jobs not an array", await call("wife", "/jobs", { jobs: "x" })],
  ["job with bad kind", await call("wife", "/jobs", { jobs: [{ at: CLOCK + 9e5, uids: [SUPER], kind: "x" }] })],
  ["bad fam in /policy", await call(SUPER, "/policy", { fam: "../x" })],
];
for (const [n, x] of bad) ok(x.status >= 400 && x.status < 500 && x.cors === "https://slavaborhovich.github.io", `${n} → ${x.status}`);

section("Reminders (jobs) through the cron");
resetWorld();
const T = Math.ceil(CLOCK / 3600e3) * 3600e3 + 3600e3;
await call("wife", "/jobs", { jobs: [{ at: T, uids: [SUPER, "wife"], kind: "digest" }, { at: T + 30 * 60e3, uids: ["wife"], kind: "remind" }] });
let reps = await minutes(75, T - 5 * 60e3);
ok(count(delivered(), "S1") === 1 && count(delivered(), "W1") === 2, `each reminder exactly once (S1:${count(delivered(), "S1")}, W1:${count(delivered(), "W1")})`);
ok(sum(reps, "dropped") === 0, "nothing dropped");
pushed.length = 0;
await minutes(5, T + 5 * 60e3);
ok(pushed.length === 0, "re-running minutes that were already handled sends nothing (done ids)");
CLOCK = T + 3 * 3600e3;                                                              // back to the future for the next sections

section("Concurrency: 10 /send requests at the same moment");
resetWorld(); JITTER = true; seed = 7; reads.length = 0;
await Promise.all([...Array(5)].map(() => call("wife", "/send", { uids: [SUPER], kind: "note" })).concat([...Array(5)].map(() => call(SUPER, "/send", { uids: ["wife"], kind: "shop" }))));
JITTER = false;
ok(queueKeys().length === 10, `10 separate queue items, none overwritten (${queueKeys().length})`);
reps = await minutes(4);
ok(count(delivered(), "S1") === 5 && count(delivered(), "W1") === 5, `all 10 delivered within 4 minutes, no duplicates (S1:${count(delivered(), "S1")}, W1:${count(delivered(), "W1")})`);
ok(maxPushesPerRun <= LIMITS.pushesPerRun, `never more than ${LIMITS.pushesPerRun} pushes in one run`);

section("Concurrency: two cron runs at the same time (no locks in KV)");
let lost = 0, dupMax = 0, dupRuns = 0;
for (let s = 1; s <= 40; s++) {
  resetWorld(); seed = s;
  await call("wife", "/send", { uids: [SUPER], kind: "note" }); await call(SUPER, "/send", { uids: ["wife"], kind: "shop" });
  advance(60e3); JITTER = true;
  const t = CLOCK; await Promise.all([runCron(env, t), runCron(env, t)]);
  JITTER = false; await minutes(6);
  const s1 = count(delivered(), "S1"), w1 = count(delivered(), "W1");
  if (s1 < 1 || w1 < 1) lost++;
  const d = Math.max(s1, w1) - 1; dupMax = Math.max(dupMax, d); if (d > 0) dupRuns++;
}
ok(lost === 0, `40 interleavings: nothing lost`);
ok(dupMax <= LIMITS.pushesPerRun, `duplicates happen (${dupRuns}/40 runs) but stay bounded (max ${dupMax} extra per device)`);

section("Crash in the middle (the run stops after N storage/network operations)");
let crashLost = 0, crashDupMax = 0, points = 0;
for (let n = 1; n <= 30; n++) {
  resetWorld();
  await call("wife", "/send", { uids: [SUPER], kind: "note" }); await call(SUPER, "/send", { uids: ["wife"], kind: "shop" });
  advance(60e3);
  crashAfter = n; runCron(env, CLOCK);                                               // never awaited: it hangs = died
  await new Promise(r => setTimeout(r, 5)); crashAfter = Infinity; points++;
  _test.resetMemory();                                                               // the next run is a fresh instance
  await minutes(6);
  const s1 = count(delivered(), "S1"), w1 = count(delivered(), "W1");
  if (s1 < 1 || w1 < 1) crashLost++;
  crashDupMax = Math.max(crashDupMax, s1 - 1, w1 - 1);
}
ok(crashLost === 0, `a crash at each of ${points} points: nothing lost`);
ok(crashDupMax <= 1, `a crash can cause a duplicate (max ${crashDupMax} extra per device), never more`);

section("Stale reads (KV propagation lag)");
resetWorld();
await call("wife", "/send", { uids: [SUPER], kind: "note" });
await minutes(1);
_test.resetMemory(); staleNext.add("cron:prod");                                    // a different instance reads the old state
await minutes(3);
ok(count(delivered(), "S1") <= 2 && count(delivered(), "S1") >= 1, `old cron state read once → at most one duplicate (${count(delivered(), "S1")} deliveries)`);
resetWorld();
await call("wife", "/send", { uids: [SUPER], kind: "note" });
await minutes(1); staleNext.add("cron:prod"); await minutes(3);
ok(count(delivered(), "S1") === 1, "same instance: the in-memory copy hides the stale read (no duplicate)");
resetWorld();
await call("wife", "/send", { uids: [SUPER], kind: "note" });
hideInList.add(queueKeys()[0]);                                                      // the list doesn't show the new item yet
reps = await minutes(3);
ok(count(delivered(), "S1") === 1, "an item missing from the first list is picked up by the next run (hint window)");
resetWorld();
faults.add("PUT:qhint:prod");
r = await call("wife", "/send", { uids: [SUPER], kind: "note" });
faults.clear();
ok(r.json.queued === 1 && !live("qhint:prod"), "hint write failed → the request still succeeds (item stored)");
const toSafety = (LIMITS.listEveryMin - (Math.floor(CLOCK / 60e3) % LIMITS.listEveryMin)) % LIMITS.listEveryMin || LIMITS.listEveryMin;
await minutes(toSafety);
ok(count(delivered(), "S1") === 1, `…delivered by the safety listing within ${LIMITS.listEveryMin} minutes`);

section("Temporary failures, retries, dead devices");
resetWorld();
pushStatus.S1 = [503, 503];
await call("wife", "/send", { uids: [SUPER], kind: "note" });
reps = await minutes(4);
ok(count(delivered(), "S1") === 1 && sum(reps, "retried") === 2, `503, 503, then delivered on the 3rd attempt (retries: ${sum(reps, "retried")})`);
resetWorld();
pushStatus.S1 = [503, 503, 503, 503];
await call("wife", "/send", { uids: [SUPER], kind: "note" });
reps = await minutes(6);
ok(count(delivered(), "S1") === 0 && sum(reps, "dropped") === 1, "after 3 failed attempts it is dropped — and counted, not silent");
delete pushStatus.S1;
resetWorld();
pushStatus.S1 = [0];                                                                 // network error: may or may not have arrived
await call("wife", "/send", { uids: [SUPER], kind: "note" });
await minutes(3);
ok(count(delivered(), "S1") === 1, "network error → retried (a real phone might get it twice: documented)");
resetWorld();
await call(SUPER, "/subscribe", { sub: await device("gone-1") });
await call("wife", "/send", { uids: [SUPER], kind: "note" });
await minutes(2);
ok(!JSON.stringify(subsOf("prod", "home")).includes("gone-1") && count(delivered(), "S1") === 1, "410 Gone → that device is removed, the other still delivered");

section("Budget and device cap");
resetWorld();
for (let i = 0; i < 4; i++) { await call(SUPER, "/subscribe", { sub: await device("S-x" + i) }); await call("wife", "/subscribe", { sub: await device("W-x" + i) }); }
for (let i = 0; i < 5; i++) { await call("wife", "/send", { uids: [SUPER], kind: "note" }); await call(SUPER, "/send", { uids: ["wife"], kind: "shop" }); }
maxSubreq = 0; maxPushesPerRun = 0;
reps = await minutes(40);
const expectedDeliveries = 5 * 5 + 5 * 5;                                            // 5 items × 5 devices, both ways
ok(delivered().length === expectedDeliveries, `heavy load (50 device deliveries): all delivered exactly once (${delivered().length})`);
ok(maxPushesPerRun <= LIMITS.pushesPerRun, `≤ ${LIMITS.pushesPerRun} devices per run (max ${maxPushesPerRun})`);
ok(maxSubreq <= LIMITS.subreqBudget, `≤ ${LIMITS.subreqBudget} subrequests in any invocation (max ${maxSubreq}; free limit 50)`);
for (let i = 0; i < 4; i++) { await call(SUPER, "/unsubscribe", { endpoint: "https://push.test/S-x" + i }); await call("wife", "/unsubscribe", { endpoint: "https://push.test/W-x" + i }); }

section("Production and test share one budget, queues never mix");
resetWorld();
await call(SUPER, "/subscribe", { env: "test", sub: await device("TS1") });
for (let i = 0; i < 3; i++) await call("wife", "/send", { env: "test", uids: [SUPER], kind: "note" });
for (let i = 0; i < 3; i++) await call("wife", "/send", { uids: [SUPER], kind: "note" });
maxPushesPerRun = 0; let testPerRun = 0;
for (let i = 1; i <= 8; i++) { const p0 = pushed.length; await minutes(1); const got = pushed.slice(p0).map(p => p.name); testPerRun = Math.max(testPerRun, got.filter(n => n.startsWith("T")).length); }
ok(count(delivered(), "S1") === 3 && count(delivered(), "TS1") === 3, `prod items to prod devices, test items to test devices (S1:${count(delivered(), "S1")}, TS1:${count(delivered(), "TS1")})`);
ok(maxPushesPerRun <= LIMITS.pushesPerRun && testPerRun <= LIMITS.pushesPerRunTest, `one run: ≤ ${LIMITS.pushesPerRun} in total, test ≤ ${LIMITS.pushesPerRunTest}`);

section("Permission: disabled, frozen, new families never get anything");
resetWorld();
FAMDB.fB.push = true; await call(SUPER, "/policy", { fam: "fB" });
await call("b1", "/subscribe", { sub: DEV.B1.sub });
await call("b1", "/send", { uids: ["b2"], kind: "task" }); await call("b2", "/subscribe", { sub: await device("B2") });
await call("b2", "/send", { uids: ["b1"], kind: "task" });
FAMDB.fB.push = false; r = await call(SUPER, "/policy", { fam: "fB" });              // turned off with items already queued
ok(r.json.families.fB.allowed === false && r.json.families.fB.verified === true && !r.json.allow.includes("fB"), "disable confirmed by the server (verified)");
reads.length = 0; writes.length = 0;
reps = await minutes(3);
ok(!delivered().some(n => n.startsWith("B")), "queued items of a disabled family are never sent");
ok(!reads.some(k => /^(q|jobs|subs|roster):prod:fB/.test(k)), "the cron did not read any of its queue items, plan, devices or members");
ok(sum(reps, "blocked") >= 2, `its items were counted as blocked (${sum(reps, "blocked")})`);
ok((await call("b1", "/send", { uids: ["b2"], kind: "task" })).json.error === "push-off", "…and it cannot queue new ones");
FAMDB.fC = { push: true, active: false }; await call(SUPER, "/policy", { fam: "fC" });   // frozen, one user still active by mistake
ok((await call("c1", "/send", { uids: ["c1"], kind: "task" })).json.error === "push-off", "a frozen family is refused even with push on and an active user");
FAMDB.fN = { name: "חדשה" }; USERS.n1 = { family: "fN", role: "admin", active: true };
r = await call(SUPER, "/policy");
ok(!r.json.allow.includes("fN") && (await call("n1", "/subscribe", { sub: await device("N1") })).json.error === "push-off", "a new family (no 'push') stays off");
FAMDB.fC = { push: false };

section("Permission: sync failures, old settings, missing data — all fail closed");
resetWorld();
fsDown = true;
r = await call(SUPER, "/policy", { fam: "home" });
ok(r.status === 503, "database unreachable → no change without verification (503)");
fsDown = false;
FAMDB.fB.push = true; await call(SUPER, "/policy", { fam: "fB" });
famDown = true;                                                                     // sign-in works, the family document can't be read
ok((await call(SUPER, "/policy", { fam: "fB" })).status === 503, "family document unreadable → no change without verification");
r = await call(SUPER, "/policy", { fam: "fB", off: true });
famDown = false;
ok(r.json.families.fB.allowed === false && r.json.families.fB.verified === false, "turning OFF still works unverified (only the safe direction), marked unverified");
await call(SUPER, "/policy", { fam: "fB" });
ok(getJ("pol:fB").on === true, "the next verified sync restores the database's value");
FAMDB.fB.push = false; await call(SUPER, "/policy", { fam: "fB" });
const polHome = store.get("pol:home").v;
const homeBlocked = async (label, mut) => {
  resetWorld(); mut();
  await call("wife", "/send", { uids: [SUPER], kind: "note" }).catch(() => {});
  store.set("pol:home", { v: JSON.stringify({ ...JSON.parse(polHome), at: CLOCK }), exp: 0 }); _test.resetMemory();
  const q = queueKeys().length;
  mut(); const rr = await minutes(2);
  ok(count(delivered(), "S1") === 0, `${label} → nothing sent${q ? "" : " (nothing queued)"}`);
  store.set("pol:home", { v: polHome, exp: 0 });
};
await homeBlocked("setting older than 48 h", () => store.set("pol:home", { v: JSON.stringify({ ...JSON.parse(polHome), at: CLOCK - LIMITS.policyMaxAgeMs - 1 }), exp: 0 }));
await homeBlocked("no setting stored", () => store.delete("pol:home"));
await homeBlocked("'on' stored as a string", () => store.set("pol:home", { v: JSON.stringify({ ...JSON.parse(polHome), on: "true", at: CLOCK }), exp: 0 }));
const allowSaved = store.get("allow");
await homeBlocked("no allow list (admin never synced)", () => store.delete("allow"));
store.set("allow", allowSaved);
store.set("pol:home", { v: JSON.stringify({ on: true, act: true, at: CLOCK }), exp: 0 });
FAMDB.home.push = "true"; r = await call(SUPER, "/policy", { fam: "home" }); FAMDB.home.push = true;
ok(r.json.families.home.allowed === false, "a non-boolean 'push' in the database counts as off");
await call(SUPER, "/policy", { fam: "home" });
// a member's call renews the setting hourly from the database (catches a change the admin's sync missed)
store.set("pol:home", { v: JSON.stringify({ on: true, act: true, at: CLOCK - LIMITS.policyRefreshMs - 1 }), exp: 0 });
FAMDB.home.push = false;
ok((await call("wife", "/send", { uids: [SUPER], kind: "note" })).json.error === "push-off" && getJ("pol:home").on === false, "a member's call after 1 h re-reads the database and sees 'off'");
FAMDB.home.push = true; store.set("pol:home", { v: JSON.stringify({ on: true, act: true, at: CLOCK - LIMITS.policyRefreshMs - 1 }), exp: 0 });
await call("wife", "/send", { uids: [SUPER], kind: "note" });
ok(getJ("pol:home").on === true && CLOCK - getJ("pol:home").at < 1000, "…and renews it when it is still on (the 48 h start again)");
// the primary family must come from the admin's real profile
const fam0 = USERS[SUPER].family; delete USERS[SUPER].family;
r = await call(SUPER, "/policy");
ok(r.status === 409 && r.json.error === "no-primary", "admin profile without a family → /policy refuses (never assumes \"home\")");
USERS[SUPER].family = fam0;
// deleting a family removes its data
FAMDB.fB.push = true; await call(SUPER, "/policy", { fam: "fB" }); delete FAMDB.fB;
r = await call(SUPER, "/policy", { fam: "fB" });
ok(r.json.families.fB.gone === true && !live("pol:fB") && !live("subs:prod:fB") && !r.json.allow.includes("fB"), "a deleted family's setting, devices and plan are removed");
FAMDB.fB = { push: false };

section("Primary family first — many families, small budget");
resetWorld();
const extra = [];
for (let i = 0; i < 30; i++) { const f = "fx" + i; FAMDB[f] = { push: true }; USERS["u" + i] = { family: f, role: "admin", active: true }; extra.push(f); }
await call(SUPER, "/policy");
for (const f of extra) await call(SUPER, "/policy", { fam: f });                      // members lists, so they could receive
for (let i = 0; i < 30; i++) { await call("u" + i, "/subscribe", { sub: await device("X" + i) }); await call("u" + i, "/send", { uids: ["u" + i], kind: "note" }).catch(() => {}); }
for (let i = 0; i < 30; i++) { USERS["u" + i + "b"] = { family: "fx" + i, role: "editor", active: true }; }
for (let i = 0; i < 30; i++) await call("u" + i + "b", "/send", { uids: ["u" + i], kind: "task" }).catch(() => {});
await call("wife", "/send", { uids: [SUPER], kind: "note" });
let firstRun = null; maxSubreq = 0;
for (let m = 1; m <= 3; m++) { const p0 = pushed.length; await minutes(1); if (!firstRun) firstRun = pushed.slice(p0).map(p => p.name); }
ok(firstRun && firstRun[0] === "S1", `30 other families waiting: our family is sent first (${firstRun.slice(0, 3).join()})`);
ok(maxSubreq <= LIMITS.subreqBudget, `budget never exceeded (${maxSubreq})`);
for (const f of extra) { delete FAMDB[f]; } for (let i = 0; i < 30; i++) { delete USERS["u" + i]; delete USERS["u" + i + "b"]; }
await call(SUPER, "/policy");

section("Late work is dropped and counted, never sent late");
resetWorld();
await call("wife", "/send", { uids: [SUPER], kind: "note" });
advance(LIMITS.lateMs + 5 * 60e3);
reps = await minutes(LIMITS.listEveryMin);
ok(count(delivered(), "S1") === 0 && sum(reps, "dropped") === 1, "worker down 35 min → the item is dropped and counted");

section("Readable notifications: text, tags, how long text is kept");
resetWorld();
r = await call("wife", "/send", { uids: [SUPER], kind: "shop", title: "🛒 תהילה הוסיפה 3 פריטים", body: "חלב, ביצים, לחם", tag: "g-shop-1" });
ok(r.status === 200 && r.json.queued === 1, "/send with title + body + tag is queued");
await minutes(2);
let m2 = await decrypt("S1", pushed[pushed.length - 1].body);
ok(m2.data.title === "🛒 תהילה הוסיפה 3 פריטים" && m2.data.body === "חלב, ביצים, לחם" && m2.data.tag === "g-shop-1" && m2.data.tab === "shop", `the phone gets the text and tag (${m2.data.title} / ${m2.data.body})`);
ok(!JSON.stringify(getJ("cron:prod") || {}).includes("חלב"), "after delivery the cron state holds no text");
advance(2 * 3600e3 + 60e3);
ok(![...store.keys()].filter(k => live(k)).map(k => store.get(k).v).join(" ").includes("חלב"), "2 hours later the text is gone from storage (queue item expired by itself)");
resetWorld();
r = await call("wife", "/send", { uids: [SUPER], kind: "task", title: "x".repeat(300), body: "y".repeat(500) });
await minutes(2);
m2 = await decrypt("S1", pushed[pushed.length - 1].body);
ok(m2.data.title.length === TEXT.title && m2.data.body.length === TEXT.body, `long text is cut (${m2.data.title.length}/${m2.data.body.length})`);
ok((await call("wife", "/send", { uids: [SUPER], kind: "task", title: "a", tag: "bad tag!" })).status === 400, "bad tag rejected");
ok((await call("wife", "/send", { uids: [SUPER], kind: "task", title: { x: 1 } })).status === 400, "non-text title rejected");
resetWorld();
r = await call("wife", "/send", { uids: [SUPER], kind: "task", title: "שורה\u0007", body: "" });
await minutes(2);
m2 = await decrypt("S1", pushed[pushed.length - 1].body);
ok(m2.data.title === "שורה" && m2.data.body === "", "control characters removed; empty body allowed");

section("Readable reminders: two different reminders at the same minute both go out");
resetWorld();
const RT = Math.floor((CLOCK + 3 * 3600e3) / 60e3) * 60e3;
r = await call("wife", "/jobs", { jobs: [
  { at: RT, uids: [SUPER], kind: "remind", title: "📅 מחר: רופא שיניים", body: "17:30", tag: "r1" },
  { at: RT, uids: [SUPER], kind: "remind", title: "🗓️ בעוד שבוע: לחדש ביטוח", body: "יעד: 19.10", tag: "r2" } ] });
ok(r.status === 200 && r.json.jobs === 2, "plan with text accepted");
CLOCK = RT - 60e3;
await minutes(LIMITS.remindSpreadMin + 2);
const got = []; for (const p of pushed) got.push((await decrypt(p.name, p.body)).data.title);
ok(got.includes("📅 מחר: רופא שיניים") && got.includes("🗓️ בעוד שבוע: לחדש ביטוח"), `both delivered (${got.join(" | ")})`);
r = await call("wife", "/jobs", { jobs: [{ at: RT + 864e5, uids: [SUPER], kind: "remind" }] });
ok(r.status === 200, "a plan item without text still works (generic text)");

section("New version announcement (from the deploy workflow)");
resetWorld();
const ann = async (body, key, e = "prod") => {
  const headers = { "content-type": "application/json" }; if (key) headers["x-nido-key"] = key;
  const res = await W.fetch(new Request("https://worker.test/announce", { method: "POST", headers, body: JSON.stringify({ env: e, ...body }) }), env);
  return { status: res.status, json: await res.json() };
};
ok((await ann({ title: "🆕 Nido עודכנה" }, "whatever")).status === 503, "closed while ANNOUNCE_KEY is not set");
env.ANNOUNCE_KEY = "k".repeat(32);
ok((await ann({ title: "🆕 Nido עודכנה" }, "wrong".repeat(7))).status === 401, "wrong key rejected");
ok((await ann({ title: "🆕 Nido עודכנה" })).status === 401, "missing key rejected");
ok((await ann({ body: "no title" }, env.ANNOUNCE_KEY)).status === 400, "a title is required");
USERS.wife.notif = { update: false };
await call(SUPER, "/roster");
r = await ann({ title: "🆕 Nido עודכנה", body: "חדש: התראות מאוחדות" }, env.ANNOUNCE_KEY);
const qi = getJ(queueKeys()[0]) || {};
ok(r.status === 200 && Object.keys(r.json.families).join() === "home" && qi.u.includes(SUPER) && !qi.u.includes("wife"), `only the allowed family; whoever turned it off is skipped (${JSON.stringify(r.json.families)}, ${qi.u})`);
await minutes(2);
m2 = await decrypt("S1", pushed[pushed.length - 1].body);
ok(delivered().join() === "S1" && m2.data.title === "🆕 Nido עודכנה" && m2.data.tag === "update", `delivered to Slava only (${delivered().join()})`);
delete USERS.wife.notif; await call(SUPER, "/roster"); delete env.ANNOUNCE_KEY;

section("Firestore rules (text check only — the rules engine can't run here)");
const rulesSrc = readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8");
const famBlock = rulesSrc.slice(rulesSrc.indexOf("match /families/{fid} {"), rulesSrc.indexOf("match /envs/{env}/{col}/{id}"));
ok(/allow write:\s*if boot\(\);/.test(famBlock), "families/{fid} is written only by the system admin (text check, NOT the rules engine)");

section("VAPID and code hygiene");
const r503 = await W.fetch(new Request("https://worker.test/vapid", { method: "GET" }), { NIDO: KV });
ok(r503.status === 503, "no secrets configured → 503, nothing is generated");
const src = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
ok(!src.includes('generateKey({ name: "ECDSA"'), "the worker never generates a signing key");
const handleSrc = src.slice(src.indexOf("async function handle"), src.indexOf("/* ================= CRON"));
ok(!/pushOne\(/.test(handleSrc), "the HTTP handler contains no push call at all (cron only)");

section("Production / test navigation separation (sw.js)");
const sw = readFileSync(new URL("../../sw.js", import.meta.url), "utf8");
const fnSrc = sw.slice(sw.indexOf("function sameApp"), sw.indexOf("self.addEventListener(\"notificationclick\""));
const mk = scope => new Function("self", fnSrc + "; return sameApp;")({ registration: { scope } });
const prodSW = mk("https://slavaborhovich.github.io/nido/"), testSW = mk("https://slavaborhovich.github.io/nido/test/");
ok(prodSW("https://slavaborhovich.github.io/nido/?tab=tasks") && !prodSW("https://slavaborhovich.github.io/nido/test/"), "prod notification never focuses the test app");
ok(testSW("https://slavaborhovich.github.io/nido/test/?tab=cal") && !testSW("https://slavaborhovich.github.io/nido/"), "test notification never focuses the prod app");
ok(/tag:\s*data\.tag/.test(sw), "notifications carry a tag (a repeated delivery replaces the earlier one)");

log0(`\n${failures ? "✘ " + failures + " FAILED" : "✔ all passed"} (${passed} checks) · max subrequests in one invocation: ${maxSubreq} · KV+fetch ops: ${ops}`);
process.exit(failures ? 1 : 0);
