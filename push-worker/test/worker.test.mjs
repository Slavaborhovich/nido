// Local tests for the Nido push worker — mocks only: no network, no Cloudflare, no Firebase, no real phones.
// Run: node push-worker/test/worker.test.mjs
import W, { runCron, LIMITS, KINDS, messageOf, slotOf } from "../worker.js";
import { readFileSync } from "node:fs";

let failures = 0;
const ok = (c, m) => { console.log((c ? "  ✔ " : "  ✘ FAIL ") + m); if (!c) failures++; };
const section = t => console.log("\n" + t);

/* ---------- mock KV (with fault injection and per-invocation counters) ---------- */
const store = new Map(); const faults = new Set(); let ops = 0;
const KV = {
  async get(k, t) { ops++; if (faults.has(k)) throw new Error("kv down"); const v = store.get(k); return v == null ? null : (t === "json" ? JSON.parse(v) : v); },
  async put(k, v) { ops++; if (faults.has("PUT") || faults.has(k)) throw new Error("kv write failed"); store.set(k, v); },
  async delete(k) { ops++; store.delete(k); },
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
const tok = (uid, { sig = "good", aud = PROJECT, exp = 3600 } = {}) => "h." + Buffer.from(JSON.stringify({ aud, iss: `https://securetoken.google.com/${aud}`, sub: uid, user_id: uid, exp: Math.floor(Date.now() / 1000) + exp })).toString("base64url") + "." + sig;
const pushed = []; let fetches = 0;
globalThis.fetch = async (url, opt = {}) => {
  fetches++;
  url = String(url);
  if (url.includes("firestore.googleapis.com")) {
    const t = (opt.headers.Authorization || "").replace("Bearer ", "");
    const claims = JSON.parse(Buffer.from(t.split(".")[1], "base64url"));
    if (!t.endsWith(".good") || claims.exp * 1000 < Date.now() || claims.aud !== PROJECT) return new Response("{}", { status: 401 });   // Firestore verifies the token
    const me = USERS[claims.user_id];
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
const names = pushed.map(p => p.name), dup = names.filter((n, i) => names.indexOf(n) !== i);
ok(rep.familyErrors > 0 && names.some(n => n.startsWith("B")) && names.some(n => n.startsWith("A")), `a broken family (errors: ${rep.familyErrors}) did not stop the others`);
ok(Math.max(...perMinute) <= LIMITS.pushesPerCron, `no run sent more than ${LIMITS.pushesPerCron} pushes (max ${Math.max(...perMinute)})`);
const expected = { home: (1 + 4) * 2 + 1, fB: (1 + 3) * 2 + 1 };
// each device gets: its digest (if its user has one) + the reminder → count distinct deliveries per device
const perDevice = names.reduce((m, n) => (m[n] = (m[n] || 0) + 1, m), {});
ok(Object.values(perDevice).every(v => v <= 2), "no device got more than its digest + reminder (no duplicates)");
ok(!store.has("carry:prod"), "everything carried over was eventually sent (carry list empty)");
ok(maxSubreq <= 50, `max subrequests in any single invocation: ${maxSubreq} (free limit 50)`);
// a repeated run of an already-processed minute
const before = pushed.length; await cron(T + 40 * 60e3); await cron(T + 40 * 60e3);
ok(pushed.length === before, "re-running minutes with nothing due sends nothing");
// the carry can't be saved before sending → that family sends nothing this run (never a later duplicate), and it is reported
await call("a1", "/jobs", { jobs: [{ at: T + 3 * 3600e3, uids: ["a1", "a2", "av"], kind: "remind" }] });
const keep = LIMITS.pushesPerCron; LIMITS.pushesPerCron = 1;                       // force an overflow that needs the carry
faults.add("PUT");
const p1 = pushed.length; const crash = { sent: 0, familyErrors: 0 };
for (let m = 0; m <= LIMITS.remindSpreadMin; m++) { const r = await cron(T + 3 * 3600e3 + m * 60e3); crash.sent += r.sent; crash.familyErrors += r.familyErrors; }
faults.delete("PUT"); LIMITS.pushesPerCron = keep;
ok(pushed.length === p1 && crash.familyErrors > 0, `carry not saved → nothing sent, reported as error (errors: ${crash.familyErrors}, pushes: ${pushed.length - p1})`);

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
