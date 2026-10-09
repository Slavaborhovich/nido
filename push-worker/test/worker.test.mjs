// Local tests for the Nido push worker — mocks only: no network, no Cloudflare, no Firebase, no real phones.
// Run: node push-worker/test/worker.test.mjs
import W, { runCron, LIMITS, KINDS, messageOf, slotOf, allowed } from "../worker.js";
import { readFileSync } from "node:fs";

let failures = 0;
const log0 = console.log; console.log = (...a) => { if (typeof a[0] === "string" && a[0].startsWith('{"cron"')) return; log0(...a); };   // the cron report line
const ok = (c, m) => { console.log((c ? "  ✔ " : "  ✘ FAIL ") + m); if (!c) failures++; };
const section = t => console.log("\n" + t);

/* ---------- mock KV (with fault injection and per-invocation counters) ---------- */
const store = new Map(); const faults = new Set(); let ops = 0; const reads = [], writes = [];
const KV = {
  async get(k, t) { ops++; reads.push(k); if (faults.has(k)) throw new Error("kv down"); const v = store.get(k); return v == null ? null : (t === "json" ? JSON.parse(v) : v); },
  async put(k, v) { ops++; writes.push(k); if (faults.has("PUT") || faults.has(k)) throw new Error("kv write failed"); store.set(k, v); },
  async delete(k) { ops++; writes.push(k); store.delete(k); },
};
const vapid = await (async () => {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  return { pub: Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64url"), d: (await crypto.subtle.exportKey("jwk", kp.privateKey)).d };
})();
const env = { NIDO: KV, VAPID_PUBLIC: vapid.pub, VAPID_PRIVATE: vapid.d };

/* ---------- mock Firestore + push services ---------- */
const PROJECT = "nido-family-72346";
const USERS = {
  a1: { family: "home", role: "admin", active: true }, a2: { family: "home", role: "editor", active: true }, av: { family: "home", role: "viewer", active: true },
  b1: { family: "fB", role: "admin", active: true }, b2: { family: "fB", role: "editor", active: true },
  c1: { family: "fC", role: "editor", active: true },
  off: { family: "home", role: "editor", active: false },
  K2TaGlPsCJQ7W4HPdaOwQqvRKGS2: { family: "home", role: "admin", active: true },
};
const SUPER = "K2TaGlPsCJQ7W4HPdaOwQqvRKGS2";
// families in Firestore: push = the system admin's switch; active === false = frozen in the app
const FAMDB = { home: { push: true }, fB: { push: true }, fC: { push: true } };
const fsVal = v => typeof v === "boolean" ? { booleanValue: v } : { stringValue: String(v) };
const famFields = f => Object.fromEntries(Object.entries(f).filter(([k]) => k === "push" || k === "active").map(([k, v]) => [k, fsVal(v)]));
const tok = (uid, { sig = "good", aud = PROJECT, exp = 3600 } = {}) => "h." + Buffer.from(JSON.stringify({ aud, iss: `https://securetoken.google.com/${aud}`, sub: uid, user_id: uid, exp: Math.floor(Date.now() / 1000) + exp })).toString("base64url") + "." + sig;
const pushed = []; let fetches = 0;
let fsFamiliesDown = false;                                                           // simulate Firestore unreachable for family documents
globalThis.fetch = async (url, opt = {}) => {
  fetches++;
  url = String(url);
  if (fsFamiliesDown && url.includes("/documents/families")) throw new Error("network");
  if (url.includes("firestore.googleapis.com")) {
    const t = (opt.headers.Authorization || "").replace("Bearer ", "");
    const claims = JSON.parse(Buffer.from(t.split(".")[1], "base64url"));
    if (!t.endsWith(".good") || claims.exp * 1000 < Date.now() || claims.aud !== PROJECT) return new Response("{}", { status: 401 });   // Firestore verifies the token
    const me = USERS[claims.user_id], isSuperCaller = claims.user_id === SUPER;
    if (url.includes("/documents/families")) {                                       // rules: families/{fid} read if boot() || inFamily(fid)
      const rest = url.split("/documents/families")[1];
      if (rest.startsWith("?")) {                                                    // list: only the system admin
        if (!isSuperCaller) return new Response("{}", { status: 403 });
        return new Response(JSON.stringify({ documents: Object.entries(FAMDB).map(([id, f]) => ({ name: `projects/x/databases/(default)/documents/families/${id}`, fields: famFields(f) })) }), { status: 200 });
      }
      const fid = rest.slice(1);
      if (!isSuperCaller && !(me && me.active && me.family === fid)) return new Response("{}", { status: 403 });
      if (!FAMDB[fid]) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ name: `x/families/${fid}`, fields: famFields(FAMDB[fid]) }), { status: 200 });
    }
    if (url.endsWith(":runQuery")) {
      const fam = JSON.parse(opt.body).structuredQuery.where.fieldFilter.value.stringValue;
      const isSuper = claims.user_id === "K2TaGlPsCJQ7W4HPdaOwQqvRKGS2";
      if (!me || !me.active || (!isSuper && me.family !== fam)) return new Response("[]", { status: 403 });   // rules: only own family (or the system admin)
      return new Response(JSON.stringify(Object.entries(USERS).filter(([, u]) => u.family === fam).map(([uid, u]) => ({ document: { name: `projects/x/databases/(default)/documents/users/${uid}`, fields: { active: { booleanValue: u.active }, role: { stringValue: u.role }, family: { stringValue: u.family } } } }))), { status: 200 });
    }
    const uid = url.split("/users/")[1];
    if (uid !== claims.user_id || !USERS[uid]) return new Response("{}", { status: uid !== claims.user_id ? 403 : 404 });
    const u = USERS[uid];
    return new Response(JSON.stringify({ fields: { active: { booleanValue: u.active }, role: { stringValue: u.role }, family: { stringValue: u.family } } }), { status: 200 });
  }
  if (url.startsWith("https://push.test/")) {
    const name = url.split("/").pop();
    pushed.push({ name, body: new Uint8Array(await new Response(opt.body).arrayBuffer()) });
    if (name.startsWith("gone")) return new Response("", { status: 410 });
    if (name.startsWith("temp")) return new Response("", { status: 503 });
    if (name.startsWith("bad")) return new Response("", { status: 400 });
    return new Response("", { status: 201 });
  }
  throw new Error("unexpected fetch " + url);
};

/* ---------- subscriptions with real keys, so payloads can be decrypted and inspected ---------- */
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

/* ---------- call helper: also checks the per-invocation subrequest count stays under 50 ---------- */
let maxSubreq = 0;
async function call(uid, path, body = {}, opts = {}) {
  const o0 = ops, f0 = fetches;
  const headers = { "content-type": "application/json" };
  if (uid) headers.authorization = "Bearer " + (opts.token || tok(uid));
  const raw = opts.raw !== undefined ? opts.raw : JSON.stringify({ env: "prod", ...body });
  const r = await W.fetch(new Request("https://worker.test/" + path.replace(/^\//, ""), { method: "POST", headers, body: raw }), env);
  maxSubreq = Math.max(maxSubreq, ops - o0 + fetches - f0);
  return { status: r.status, json: await r.json(), cors: r.headers.get("access-control-allow-origin") };
}
async function cron(t) { const o0 = ops, f0 = fetches; const r = await runCron(env, t); maxSubreq = Math.max(maxSubreq, ops - o0 + fetches - f0); return r; }
const subsOf = (e, f) => JSON.parse(store.get(`subs:${e}:${f}`) || '{"list":{}}').list;

/* =============================== tests =============================== */
section("Setup");
for (const [u, d] of [["a1", "A1"], ["a2", "A2"], ["av", "AV"], ["b1", "B1"], ["b2", "B2"], ["c1", "C1"]]) ok((await call(u, "/subscribe", { sub: await device(d) })).status === 200, `${u} subscribes`);
ok((await call("a1", "/subscribe", { sub: DEV.A1.sub })).json.same === true, "re-subscribing the same device writes nothing");

section("Authentication");
ok((await call("a1", "/send", { uids: ["a2"], kind: "task" }, { token: tok("a1", { sig: "forged" }) })).status === 401, "forged token rejected");
ok((await call("a1", "/send", { uids: ["a2"], kind: "task" }, { token: tok("a1", { exp: -10 }) })).status === 401, "expired token rejected");
ok((await call("a1", "/send", { uids: ["a2"], kind: "task" }, { token: tok("a1", { aud: "other-project" }) })).status === 401, "token for another project rejected");
ok((await call(null, "/send", { uids: ["a2"], kind: "task" })).status === 401, "no token rejected");

section("Cross-family isolation");
pushed.length = 0;
await call("a1", "/send", { uids: ["a2", "b1", "b2", "c1"], kind: "task" });
ok(pushed.map(p => p.name).join() === "A2", `home → [a2,b1,b2,c1] reaches only home's a2 (got ${pushed.map(p => p.name).join()})`);
pushed.length = 0; await call("b1", "/send", { uids: ["a1", "a2"], kind: "task" });
ok(pushed.length === 0, "fB cannot reach home users");
await call("b1", "/jobs", { fam: "home", jobs: [{ at: Date.now() + 10 * 60e3, uids: ["a1"], kind: "remind" }] });
ok(!store.has("jobs:prod:home"), "a 'fam' field in the request is ignored (fB could not write home's plan)");
ok((await call("b1", "/unsubscribe", { endpoint: DEV.A1.sub.endpoint })).status === 403, "cannot unsubscribe another family's device");
ok((await call("b1", "/send", { env: "test", uids: ["b2"], kind: "task" })).status === 403, "other families cannot use the test environment");
ok((await call("b1", "/roster", { fam: "home" })).status === 403, "a family admin cannot refresh another family's roster");
ok((await call("K2TaGlPsCJQ7W4HPdaOwQqvRKGS2", "/roster", { fam: "fB" })).status === 200, "the system admin can refresh any family's roster");

section("Roles");
ok((await call("av", "/jobs", { jobs: [{ at: Date.now() + 10 * 60e3, uids: ["a1"], kind: "remind" }] })).status === 403, "viewer cannot change the reminder plan");
ok((await call("av", "/send", { uids: ["a1"], kind: "task" })).status === 403, "viewer cannot send notifications");
ok((await call("av", "/test")).status === 200, "viewer can test their own device");
ok((await call("a2", "/roster")).status === 403, "an editor cannot force a roster refresh");

section("Disabled and deleted users");
ok((await call("off", "/subscribe", { sub: await device("OFF") })).status === 401, "disabled user rejected");
ok((await call("ghost", "/subscribe", { sub: await device("GH") })).status === 401, "deleted (no profile) user rejected");
USERS.a2.active = false;
await call("a1", "/roster");                                                        // what the admin app does after disabling someone
ok(!subsOf("prod", "home").a2, "after disabling a2 + roster refresh, a2's devices are removed");
pushed.length = 0; await call("a1", "/send", { uids: ["a2"], kind: "task" });
ok(pushed.length === 0, "disabled user receives nothing");
USERS.a2.active = true; await call("a2", "/subscribe", { sub: DEV.A2.sub }); await call("a1", "/roster");
delete USERS.b2; await call("b1", "/roster");
ok(!subsOf("prod", "fB").b2, "deleted user's devices removed on roster refresh");
USERS.b2 = { family: "fB", role: "editor", active: true }; await call("b1", "/roster"); await call("b2", "/subscribe", { sub: DEV.B2.sub });

section("Invalid input (rejected safely, CORS kept)");
const bad = [
  ["bad json", await call("a1", "/send", {}, { raw: "{not json" })],
  ["array body", await call("a1", "/send", {}, { raw: "[1,2]" })],
  ["too large", await call("a1", "/send", {}, { raw: JSON.stringify({ env: "prod", pad: "x".repeat(20000) }) })],
  ["uids as string", await call("a1", "/send", { uids: "a2", kind: "task" })],
  ["uids with bad ids", await call("a1", "/send", { uids: ["../x"], kind: "task" })],
  ["too many uids", await call("a1", "/send", { uids: Array.from({ length: 30 }, (_, i) => "u" + i), kind: "task" })],
  ["unknown kind", await call("a1", "/send", { uids: ["a2"], kind: "free-text" })],
  ["bad env", await call("a1", "/send", { env: "staging", uids: ["a2"], kind: "task" })],
  ["bad subscription", await call("a1", "/subscribe", { sub: { endpoint: "http://x", keys: {} } })],
  ["jobs not an array", await call("a1", "/jobs", { jobs: "x" })],
  ["job with bad kind", await call("a1", "/jobs", { jobs: [{ at: Date.now() + 9e5, uids: ["a2"], kind: "x" }] })],
  ["job uids as string", await call("a1", "/jobs", { jobs: [{ at: Date.now() + 9e5, uids: "a2", kind: "remind" }] })],
  ["too many jobs", await call("a1", "/jobs", { jobs: Array.from({ length: LIMITS.jobsPerFamily + 1 }, () => ({ at: Date.now() + 9e5, uids: ["a2"], kind: "remind" })) })],
];
for (const [n, r] of bad) ok(r.status >= 400 && r.status < 500 && r.cors === "https://slavaborhovich.github.io", `${n} → ${r.status}`);

section("Generic payloads only");
pushed.length = 0; await call("a1", "/send", { uids: ["a2"], kind: "task", title: "סוד: יום הולדת לליאל", body: "מרבד הקסמים 5" });
const msg = await decrypt("A2", pushed[0].body);
ok(msg.data.title === KINDS.task.title && !JSON.stringify(msg).includes("ליאל") && !JSON.stringify(msg).includes("מרבד"), `payload is the fixed text only: "${msg.data.title}"`);
const stored = [...store.values()].join(" ");
ok(!/ליאל|מרבד|title|body|place/.test(stored), "KV holds no names, titles, places or free text");
ok(Object.values(KINDS).every(k => !/[א-ת]{2,} [א-ת]+ ל[א-ת]+ \d/.test(k.title)) && messageOf("nope") === null, "only fixed kinds are accepted");

section("Subscription cleanup");
const sendCap = LIMITS.pushesPerSend; LIMITS.pushesPerSend = 10;                  // cleanup semantics, independent of the send cap
await call("a1", "/subscribe", { sub: await device("gone-1") });
await call("a1", "/subscribe", { sub: await device("temp-1") });
await call("a1", "/subscribe", { sub: await device("bad-1") });
pushed.length = 0; await call("a2", "/send", { uids: ["a1"], kind: "event" });
const a1devs = subsOf("prod", "home").a1.map(s => s.endpoint.split("/").pop());
ok(!a1devs.includes("gone-1"), "410 Gone → subscription removed");
ok(a1devs.includes("temp-1") && pushed.filter(p => p.name === "temp-1").length === 2, "503 → kept, retried once");
ok(a1devs.includes("bad-1"), "400 → kept (not a documented 'gone' signal)");
const r400 = await call("a2", "/send", { uids: ["a1"], kind: "event" });
ok(r400.json.ok === false && r400.json.failed >= 2, `failures are reported, not hidden (ok:${r400.json.ok}, failed:${r400.json.failed})`);
await call("a1", "/unsubscribe", { endpoint: "https://push.test/temp-1" }); await call("a1", "/unsubscribe", { endpoint: "https://push.test/bad-1" });
LIMITS.pushesPerSend = sendCap;

section("Device ownership");
await call("b2", "/subscribe", { sub: DEV.A1.sub });                               // the a1 phone is now b2's
ok(!JSON.stringify(subsOf("prod", "home")).includes("/A1") && JSON.stringify(subsOf("prod", "fB")).includes("/A1"), "a device moving to another family is removed from the old one");
await call("a1", "/subscribe", { sub: DEV.A1.sub });

section("Quotas");
let r429 = null;
for (let i = 0; i < LIMITS.subWritesPerUser + 2; i++) { const r = await call("c1", "/subscribe", { sub: await device("q" + i) }); if (r.status === 429) { r429 = i; break; } }
ok(r429 !== null && r429 <= LIMITS.subWritesPerUser, `per-user daily subscription writes capped (blocked at #${r429 + 1})`);
let jw = 0, j429 = false;
for (let i = 0; i < LIMITS.planWritesPerUser + 3; i++) { const r = await call("b1", "/jobs", { jobs: [{ at: Date.now() + (10 + i) * 60e3, uids: ["b2"], kind: "remind" }] }); if (r.status === 429) { j429 = true; break; } jw++; }
ok(j429 && jw <= LIMITS.planWritesPerUser, `per-user daily plan writes capped (${jw} allowed)`);
const sameBefore = store.get("jobs:prod:home");
await call("a1", "/jobs", { jobs: [{ at: Date.now() + 3600e3, uids: ["a2"], kind: "remind" }] });
const w1 = JSON.parse(store.get("jobs:prod:home")).n;
await call("a2", "/jobs", { jobs: [{ at: Date.now() + 3600e3, uids: ["a2"], kind: "remind" }] });
ok(JSON.parse(store.get("jobs:prod:home")).n === w1 && sameBefore !== store.get("jobs:prod:home"), "same plan from another member → no extra write");

section("Cron: spreading, batching, isolation, duplicates");
// a big morning: 3 families, every member gets a digest at 08:00 tomorrow + reminders
store.delete("jobs:prod:fB"); store.delete("jobs:prod:fC"); store.delete("carry:prod");
const T = Math.ceil(Date.now() / 3600e3) * 3600e3 + 2 * 3600e3;                  // a whole hour in the future
const plan = us => ({ jobs: [...us.map(u => ({ at: T, uids: [u], kind: "digest" })), { at: T, uids: us, kind: "remind" }] });
// more devices so a single minute would overflow
for (const [u, n] of [["a1", 3], ["a2", 3], ["b1", 3], ["b2", 3]]) for (let i = 0; i < n; i++) await call(u, "/subscribe", { sub: await device(`${u}-x${i}`) });
await call("a1", "/jobs", plan(["a1", "a2", "av"])); await call("b1", "/jobs", plan(["b1", "b2"]));
USERS.c2 = { family: "fC", role: "editor", active: true }; await call("c1", "/roster");
await call("c1", "/jobs", plan(["c1"]));
const slots = new Set(["home", "fB", "fC"].flatMap(f => JSON.parse(store.get(`jobs:prod:${f}`)).jobs.map(j => slotOf(j, f))));
ok(slots.size > 3, `08:00 work is spread over ${slots.size} different minutes`);
// one family's storage is broken: others must still go out
faults.add("jobs:prod:fC");
pushed.length = 0; let rep = { sent: 0, failed: 0, carried: 0, familyErrors: 0, dropped: 0 }, perMinute = [];
for (let m = -1; m <= LIMITS.digestSpreadMin + 6; m++) {
  const p0 = pushed.length, r = await cron(T + m * 60e3);
  perMinute.push(pushed.length - p0);
  for (const k of Object.keys(rep)) rep[k] += r[k] || 0;
}
faults.delete("jobs:prod:fC");
for (let m = LIMITS.digestSpreadMin + 7; m <= LIMITS.digestSpreadMin + 20; m++) { const p0 = pushed.length; await cron(T + m * 60e3); perMinute.push(pushed.length - p0); }   // the repaired family catches up
const names = pushed.map(p => p.name), dup = names.filter((n, i) => names.indexOf(n) !== i);
ok(rep.familyErrors > 0 && names.some(n => n.startsWith("B")) && names.some(n => n.startsWith("A")), `a broken family (errors: ${rep.familyErrors}) did not stop the others`);
ok(Math.max(...perMinute) <= LIMITS.pushesPerRun, `no run sent more than ${LIMITS.pushesPerRun} pushes (max ${Math.max(...perMinute)})`);
const expected = { home: (1 + 4) * 2 + 1, fB: (1 + 3) * 2 + 1 };
// each device gets: its digest (if its user has one) + the reminder → count distinct deliveries per device
const perDevice = names.reduce((m, n) => (m[n] = (m[n] || 0) + 1, m), {});
ok(Object.values(perDevice).every(v => v <= 2), "no device got more than its digest + reminder (no duplicates)");
ok(!store.has("carry:prod") || !JSON.parse(store.get("carry:prod")).items.length, "everything carried over was eventually sent (carry list empty)");
ok(names.some(n => /^C1|^q\d/.test(n)), "the repaired family's windows were re-scanned and delivered after the fault");
ok(maxSubreq <= 50, `max subrequests in any single invocation: ${maxSubreq} (free limit 50)`);
// a repeated run of an already-processed minute
const before = pushed.length; await cron(T + 60 * 60e3); await cron(T + 60 * 60e3);
ok(pushed.length === before, "re-running minutes with nothing due sends nothing");
// the carry can't be saved before sending → that family sends nothing this run (never a later duplicate), and it is reported
await call("a1", "/jobs", { jobs: [{ at: T + 3 * 3600e3, uids: ["a1", "a2", "av"], kind: "remind" }] });
const keep = LIMITS.pushesPerRun; LIMITS.pushesPerRun = 1;                       // force an overflow that needs the carry
faults.add("PUT");
const p1 = pushed.length; const crash = { sent: 0, familyErrors: 0 };
for (let m = 0; m <= LIMITS.remindSpreadMin; m++) { const r = await cron(T + 3 * 3600e3 + m * 60e3); crash.sent += r.sent; crash.familyErrors += r.familyErrors; }
faults.delete("PUT"); LIMITS.pushesPerRun = keep;
ok(pushed.length === p1 && crash.familyErrors > 0, `carry not saved → nothing sent, reported as error (errors: ${crash.familyErrors}, pushes: ${pushed.length - p1})`);

/* ====================== per-family notification permission ====================== */
const polOf = f => JSON.parse(store.get(`pol:${f}`) || "null");
const setPol = (f, patch) => store.set(`pol:${f}`, JSON.stringify({ ...polOf(f), ...patch }));
const keysOf = f => [...store.keys()].filter(k => k.split(":").includes(f)).sort();
const snap = f => keysOf(f).map(k => k + "=" + store.get(k)).join("\n");
const minuteNow = () => Math.floor(Date.now() / 60e3) * 60e3;
const unit = (f, u, e, at, k = "task") => ({ f, k, at, u, e: "https://push.test/" + e });
const putCarry = (envName, items) => store.set(`carry:${envName}`, JSON.stringify({ items, done: {} }));
const sentNames = from => pushed.slice(from).map(p => p.name);
// a clean slate for the cron part: no plans, no queues, no carry
for (const k of [...store.keys()]) if (/^(jobs|out|carry):/.test(k)) store.delete(k);

section("Permission — who may change it");
let r = await call(SUPER, "/policy");
ok(r.status === 200 && r.json.families.home && r.json.families.fB, "1. the system admin can read and sync every family's setting");
FAMDB.fB.push = false; r = await call(SUPER, "/policy", { fam: "fB" });
ok(r.status === 200 && r.json.families.fB.allowed === false && polOf("fB").on === false, "1. the system admin's change (fB off in Firestore) is applied by the worker");
FAMDB.fB.push = true; r = await call(SUPER, "/policy", { fam: "fB" });
ok(r.json.families.fB.allowed === true, "1. … and turning it back on works");
const polBefore = store.get("pol:fB");
ok((await call("a1", "/policy", { fam: "fB" })).status === 403, "2. a family admin (not the system admin) cannot use /policy");
ok((await call("b1", "/policy", { fam: "fB", off: true })).status === 403, "2. fB's own admin cannot change fB's setting through the worker");
ok((await call("b2", "/policy")).status === 403 && store.get("pol:fB") === polBefore, "2. an editor cannot either — nothing changed");
await call("b1", "/send", { uids: ["b2"], kind: "task", push: false, on: false, allowed: true });
ok(store.get("pol:fB") === polBefore, "2. values sent from the browser are ignored (the setting is read from Firestore)");
fsFamiliesDown = true;
r = await call(SUPER, "/policy", { fam: "fB" });
ok(r.status === 503 && store.get("pol:fB") === polBefore, "1. database unreachable → no change is made without verification");
r = await call(SUPER, "/policy", { fam: "fB", off: true });
ok(r.json.families.fB.allowed === false && r.json.families.fB.verified === false, "1. … except turning OFF, which is always safe (applied, marked unverified)");
fsFamiliesDown = false; await call(SUPER, "/policy", { fam: "fB" });
ok(allowed(polOf("fB")), "1. the next verified sync restores the real setting from the database");
const rulesSrc = readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8");
const famBlock = rulesSrc.slice(rulesSrc.indexOf("match /families/{fid} {"), rulesSrc.indexOf("match /envs/{env}/{col}/{id}"));
ok(/allow write:\s*if boot\(\);/.test(famBlock), "2. Firestore rules: only the system admin may write families/{fid} (where 'push' lives)");

section("Permission — primary family");
r = await call(SUPER, "/policy");
ok(r.json.primary === "home" && polOf("home").p === 1 && polOf("fB").p === 0 && polOf("fC").p === 0, "3. primary = the system admin's own family (from his Firestore profile)");
await call("b1", "/subscribe", { sub: await device("PB1") }); await call("b2", "/subscribe", { sub: await device("PB2") });
let t0 = minuteNow() + 600 * 60e3, p0;
// fB's devices are listed FIRST in the queue and the rotation would start with fB in some minutes — home must still go first
for (let m = 0; m < 3; m++) {
  const t = t0 + m * 60e3;
  putCarry("prod", [unit("fB", "b1", "PB1", t), unit("fB", "b2", "PB2", t), unit("fB", "b1", "B1", t), unit("home", "a1", "A1", t), unit("home", "a2", "A2", t), unit("home", "av", "AV", t)]);
  p0 = pushed.length; await cron(t);
  ok(sentNames(p0).join() === "A1,A2,AV", `3. under load the primary family is sent first (minute ${m}: ${sentNames(p0).join()})`);
  store.delete("carry:prod");
}

section("Permission — disabled / frozen / new families");
FAMDB.fB.push = false; await call(SUPER, "/policy", { fam: "fB" });
const fBbefore = snap("fB");
ok((await call("b1", "/send", { uids: ["b2"], kind: "task" })).json.error === "push-off", "4. a disabled family's /send is refused (push-off)");
ok((await call("b2", "/subscribe", { sub: await device("PB3") })).status === 403 && (await call("b1", "/jobs", { jobs: [{ at: Date.now() + 9e5, uids: ["b2"], kind: "remind" }] })).status === 403, "4. … and so are /subscribe and /jobs");
t0 += 10 * 60e3;
store.set("jobs:prod:fB", JSON.stringify({ jobs: [{ at: t0 - 60e3, k: "remind", u: ["b1", "b2"] }] }));     // frozen-family data that exists in KV
store.set("out:prod:fB", JSON.stringify({ items: [{ id: "x1", k: "task", at: t0 - 1000, d: [["b2", "https://push.test/PB2"]] }] }));
putCarry("prod", [unit("fB", "b1", "PB1", t0), unit("home", "a1", "A1", t0)]);
const fBsnap = snap("fB"); reads.length = 0; writes.length = 0; p0 = pushed.length;
rep = await cron(t0);
ok(!sentNames(p0).some(n => /B/.test(n)) && sentNames(p0).includes("A1"), `4. cron: nothing to the disabled family, home still sent (${sentNames(p0).join()})`);
ok(!reads.some(k => k !== "pol:fB" && k.split(":").includes("fB")) && !writes.some(k => k.split(":").includes("fB")), "4. cron read none of fB's data (only its permission) and wrote nothing of fB");
ok(snap("fB") === fBsnap && rep.blocked === 1, `4. fB's stored data is untouched; its queued item was dropped as blocked (${rep.blocked})`);
store.delete("jobs:prod:fB"); store.delete("out:prod:fB");

FAMDB.fC = { push: true, active: false }; USERS.c1.active = true;                    // frozen in the app, one user left active by mistake
await call(SUPER, "/policy", { fam: "fC" });
ok(polOf("fC").act === false && !allowed(polOf("fC")), "5. a frozen family is not allowed even with push on");
ok((await call("c1", "/send", { uids: ["c2"], kind: "task" })).json.error === "push-off", "5. … its still-active user cannot send");
putCarry("prod", [unit("fC", "c1", "C1", t0 + 60e3)]); p0 = pushed.length; rep = await cron(t0 + 60e3);
ok(pushed.length === p0 && rep.blocked === 1, "5. … and the cron sends nothing to it");
// the same freeze reaches the worker through a member's own call too (setting older than the refresh interval)
FAMDB.fC = { push: true }; await call(SUPER, "/policy", { fam: "fC" });
FAMDB.fC.active = false; setPol("fC", { at: Date.now() - LIMITS.policyRefreshMs - 1000 });
ok((await call("c1", "/send", { uids: ["c2"], kind: "task" })).json.error === "push-off" && polOf("fC").act === false, "5. a member's call re-reads Firestore and sees the freeze");
ok(allowed({ on: true, act: true, p: 0, at: Date.now() }) === true, "5. sanity: an explicit on+active+fresh setting is allowed");

FAMDB.fN = { name: "חדשה" }; USERS.n1 = { family: "fN", role: "admin", active: true };   // created by the app: no 'push' field
ok((await call("n1", "/subscribe", { sub: await device("N1") })).json.error === "push-off", "6. a new family (no 'push' field) cannot subscribe");
await call(SUPER, "/policy");
ok(polOf("fN").on === false && !allowed(polOf("fN")), "6. … and stays off after a full sync, until the system admin turns it on");
putCarry("prod", [unit("fN", "n1", "N1", t0 + 2 * 60e3)]); p0 = pushed.length; await cron(t0 + 2 * 60e3);
ok(pushed.length === p0, "6. the cron sends nothing to it");

section("Permission — missing, invalid or old settings fail closed");
const homePol = store.get("pol:home");
const tryHome = async (label, mutate) => {
  mutate(); const t = t0 + 10 * 60e3 + Math.floor(Math.random() * 1000) * 60e3;
  putCarry("prod", [unit("home", "a1", "A1", t)]); const p = pushed.length; const rr = await cron(t);
  ok(pushed.length === p && rr.blocked === 1, "7. " + label + " → nothing sent");
  store.set("pol:home", homePol); store.delete("carry:prod");
};
await tryHome("no setting stored", () => store.delete("pol:home"));
await tryHome("setting older than 8 days", () => setPol("home", { at: Date.now() - LIMITS.policyMaxAgeMs - 1 }));
await tryHome("on is the string \"true\"", () => setPol("home", { on: "true" }));
await tryHome("no timestamp", () => setPol("home", { at: undefined }));
await tryHome("garbage value", () => store.set("pol:home", JSON.stringify("yes")));
FAMDB.fB.push = "true"; await call(SUPER, "/policy", { fam: "fB" });
ok(polOf("fB").on === false, "7. a non-boolean 'push' in Firestore counts as off");
const fCmissing = FAMDB.fC; delete FAMDB.fC;
r = await call(SUPER, "/policy", { fam: "fC" });
ok(r.json.families.fC.gone === true && !store.has("pol:fC") && !keysOf("fC").some(k => /^(subs|jobs|out|roster):/.test(k)), "7. a deleted family's setting and data are removed");
FAMDB.fC = fCmissing;
faults.add("pol:home"); putCarry("prod", [unit("home", "a1", "A1", t0 + 3 * 60e3)]); p0 = pushed.length; rep = await cron(t0 + 3 * 60e3); faults.delete("pol:home");
ok(pushed.length === p0 && JSON.parse(store.get("carry:prod")).items.length === 1, "7. setting unreadable this run → nothing sent, the item waits (not approved, not lost)");
store.delete("carry:prod");

section("Permission — changes reach the queue without anyone opening the app");
FAMDB.fB.push = true; await call(SUPER, "/policy", { fam: "fB" });
const tq = t0 + 20 * 60e3;
putCarry("prod", [unit("fB", "b1", "PB1", tq), unit("fB", "b2", "PB2", tq), unit("fB", "b1", "B1", tq), unit("fB", "b2", "B2", tq)]);
p0 = pushed.length; await cron(tq);
ok(sentNames(p0).length === 3, "8. fB allowed: 3 of its 4 queued devices sent, 1 waits");
FAMDB.fB.push = false; await call(SUPER, "/policy", { fam: "fB" });                  // only the admin acts — nobody in fB opens the app
p0 = pushed.length; rep = await cron(tq + 60e3);
ok(pushed.length === p0 && rep.blocked === 1, "8. turned off by the admin → the waiting device is dropped at the next run");
FAMDB.fB.push = true; store.set("roster:prod:fB", JSON.stringify({ ...JSON.parse(store.get("roster:prod:fB")), at: Date.now() - LIMITS.rosterMaxAgeMs - 1 }));
await call(SUPER, "/policy", { fam: "fB" });                                         // turned on again, fB's members list was old
ok(Date.now() - JSON.parse(store.get("roster:prod:fB")).at < 60e3, "8. turning on refreshes the family's members list with the admin's sign-in");
putCarry("prod", [unit("fB", "b1", "PB1", tq + 2 * 60e3)]); p0 = pushed.length; await cron(tq + 2 * 60e3);
ok(sentNames(p0).join() === "PB1", "8. … so fB is served again right away, still without anyone in fB opening the app");

section("Isolation of failures, prod/test budget");
const tf = t0 + 30 * 60e3;
faults.add("pol:fB"); putCarry("prod", [unit("fB", "b1", "PB1", tf), unit("home", "a2", "A2", tf)]); p0 = pushed.length; rep = await cron(tf); faults.delete("pol:fB");
ok(sentNames(p0).join() === "A2", "9. fB's permission unreadable → home still sent");
store.delete("carry:prod");
faults.add("roster:prod:fB"); putCarry("prod", [unit("fB", "b1", "PB1", tf + 60e3), unit("home", "a1", "A1", tf + 60e3)]); p0 = pushed.length; await cron(tf + 60e3); faults.delete("roster:prod:fB");
ok(sentNames(p0).join() === "A1", "9. fB's storage broken → home still sent");
store.delete("carry:prod");
// test-environment devices (home only)
for (const [u, d] of [["a1", "TA1"], ["a2", "TA2"], ["av", "TAV"]]) await call(u, "/subscribe", { env: "test", sub: await device(d) });
const tb = t0 + 40 * 60e3;
putCarry("prod", [unit("home", "a1", "A1", tb), unit("home", "a2", "A2", tb), unit("home", "av", "AV", tb), unit("home", "a1", "a1-x0", tb), unit("home", "a1", "a1-x1", tb)]);
putCarry("test", [unit("home", "a1", "TA1", tb), unit("home", "a2", "TA2", tb), unit("home", "av", "TAV", tb)]);
let o0 = ops, f0 = fetches; p0 = pushed.length; await cron(tb); let used = ops - o0 + fetches - f0;
ok(sentNames(p0).length === 3 && sentNames(p0).every(n => !n.startsWith("T")), `10. busy prod uses the whole run (3); test waits (${sentNames(p0).join()})`);
ok(used <= LIMITS.subreqBudget, `10. one budget for the whole run: ${used} subrequests (cap ${LIMITS.subreqBudget}, free limit 50)`);
for (let m = 1; m <= 6; m++) {
  o0 = ops; f0 = fetches; const pp = pushed.length; await cron(tb + m * 60e3); used = ops - o0 + fetches - f0;
  const got = sentNames(pp);
  if (got.length > LIMITS.pushesPerRun || got.filter(n => n.startsWith("T")).length > LIMITS.pushesPerRunTest || used > LIMITS.subreqBudget) { ok(false, `10. minute ${m} over a limit: ${got.join()} / ${used}`); break; }
}
const prodNames = sentNames(p0).filter(n => !n.startsWith("T")), testNames = sentNames(p0).filter(n => n.startsWith("T"));
ok(prodNames.length === 5 && testNames.length === 3 && new Set(sentNames(p0)).size === 8, `10. all 8 delivered over several runs, no duplicates, test ≤ ${LIMITS.pushesPerRunTest} per run`);
ok(!JSON.parse(store.get("carry:test") || '{"items":[]}').items.some(i => !i.e.includes("/T")) && !JSON.parse(store.get("carry:prod") || '{"items":[]}').items.some(i => i.e.includes("/T")), "10. prod and test queues never mix");

section("Device-level limits and the /send queue");
for (let i = 0; i < 4; i++) await call("a2", "/subscribe", { sub: await device(`a2-y${i}`) });
const a2n = subsOf("prod", "home").a2.length;
const ts = minuteNow() + 900 * 60e3;
store.set("jobs:prod:home", JSON.stringify({ jobs: [{ at: ts, k: "remind", u: ["a2"] }] }));
const fams = JSON.parse(store.get("fams:prod")); if (!fams.includes("home")) store.set("fams:prod", JSON.stringify([...fams, "home"]));
const slot = slotOf({ at: ts, k: "remind", u: ["a2"] }, "home");
p0 = pushed.length; const per = [];
for (let m = 0; m <= 4; m++) { const pp = pushed.length; await cron(slot + m * 60e3); per.push(pushed.length - pp); }
ok(a2n >= 5 && per[0] === 3 && pushed.length - p0 === a2n && new Set(sentNames(p0)).size === a2n, `a person with ${a2n} devices: 3 now, the rest next run(s), each once (${per.join(",")})`);
store.delete("jobs:prod:home");
p0 = pushed.length;
r = await call("a1", "/send", { uids: ["a2"], kind: "note" });
ok(r.json.sent === LIMITS.pushesPerSend && r.json.queued === a2n - LIMITS.pushesPerSend && r.json.ok === true, `/send: ${r.json.sent} right away, ${r.json.queued} queued (not lost)`);
const tq2 = minuteNow() + 60e3;
for (let m = 0; m < 4; m++) await cron(tq2 + m * 60e3);
await cron(tq2 + 4 * 60e3); await cron(tq2 + 5 * 60e3);
ok(pushed.length - p0 === a2n && new Set(sentNames(p0)).size === a2n, `the queued devices were delivered by the cron, each exactly once (${pushed.length - p0}/${a2n})`);

section("VAPID");
const noKeys = { NIDO: KV };
const r503 = await W.fetch(new Request("https://worker.test/vapid", { method: "GET" }), noKeys);
ok(r503.status === 503, "no secrets configured → 503, no key is generated");
ok(!readFileSync(new URL("../worker.js", import.meta.url), "utf8").includes("generateKey({ name: \"ECDSA\""), "worker code never generates a signing key");

section("Production / test navigation separation (sw.js)");
const sw = readFileSync(new URL("../../sw.js", import.meta.url), "utf8");
const fnSrc = sw.slice(sw.indexOf("function sameApp"), sw.indexOf("self.addEventListener(\"notificationclick\""));
const mk = scope => new Function("self", fnSrc + "; return sameApp;")({ registration: { scope } });
const prod = mk("https://slavaborhovich.github.io/nido/"), test = mk("https://slavaborhovich.github.io/nido/test/");
ok(prod("https://slavaborhovich.github.io/nido/?tab=tasks") && !prod("https://slavaborhovich.github.io/nido/test/"), "prod notification never focuses the test app");
ok(test("https://slavaborhovich.github.io/nido/test/?tab=cal") && !test("https://slavaborhovich.github.io/nido/"), "test notification never focuses the prod app");

console.log(`\n${failures ? "✘ " + failures + " FAILED" : "✔ all passed"} · KV+fetch ops total: ${ops + fetches} · max subrequests per invocation: ${maxSubreq}`);
process.exit(failures ? 1 : 0);
