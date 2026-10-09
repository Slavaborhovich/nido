// LOCAL CPU estimate for one cron run (Node, in-memory KV, instant fake push service).
// This is NOT a Cloudflare measurement: Workers run on a different engine/hardware and count CPU differently.
// It only shows the order of magnitude and which part costs what.   node push-worker/bench/cron-bench.mjs
import { runCron, _test } from "../worker.js";

let CLOCK = Date.UTC(2026, 9, 12, 7, 0, 0); Date.now = () => CLOCK;
const store = new Map();
const KV = {
  async get(k) { const v = store.get(k); return v == null ? null : JSON.parse(v); },
  async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); },
  async list({ prefix }) { return { keys: [...store.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })) }; },
};
globalThis.fetch = async () => new Response("", { status: 201 });
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const env = { NIDO: KV, VAPID_PUBLIC: Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64url"), VAPID_PRIVATE: (await crypto.subtle.exportKey("jwk", kp.privateKey)).d };
async function sub(name) {
  const k = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return { endpoint: "https://fcm.googleapis.com/fcm/send/" + name, keys: { p256dh: Buffer.from(await crypto.subtle.exportKey("raw", k.publicKey)).toString("base64url"), auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url") } };
}
// our real shape: one family, 2 people, 2 Android phones; plus a full 7-day plan (120 reminders) to scan
const subs = { a: [await sub("A")], b: [await sub("B")] };
function seed(items) {
  store.clear(); _test.resetMemory();
  store.set("allow", JSON.stringify({ primary: "home", fams: ["home"] }));
  store.set("pol:home", JSON.stringify({ on: true, act: true, at: CLOCK }));
  store.set("roster:prod:home", JSON.stringify({ at: CLOCK, users: { a: { a: 1 }, b: { a: 1 } } }));
  store.set("subs:prod:home", JSON.stringify({ list: subs }));
  store.set("jobs:prod:home", JSON.stringify({ jobs: Array.from({ length: 120 }, (_, i) => ({ at: CLOCK + (i + 30) * 3600e3, k: "remind", u: ["a", "b"] })) }));
  store.set("qhint:prod", JSON.stringify({ t: CLOCK }));
  for (let i = 0; i < items; i++) store.set(`q:prod:home:${(CLOCK - 1000 + i).toString(36).padStart(9, "0")}-x${i}`, JSON.stringify({ k: "note", u: i % 2 ? ["a"] : ["b"], at: CLOCK }));
}
async function measure(label, items, n = 40) {
  const t = [];
  for (let i = 0; i < n; i++) {
    seed(items); CLOCK += 60e3;
    const c0 = process.cpuUsage(); const r = await runCron(env, CLOCK); const c = process.cpuUsage(c0);
    t.push((c.user + c.system) / 1000);
    if (i === 0) label += ` (sent ${r.sent})`;
  }
  const s = [...t].sort((a, b) => a - b);
  console.log(`${label.padEnd(44)} first ${t[0].toFixed(1)} ms · median ${s[s.length >> 1].toFixed(1)} ms · max of the rest ${Math.max(...t.slice(1)).toFixed(1)} ms`);
}
console.log("LOCAL Node estimate — not Cloudflare. CPU per cron run:");
await measure("nothing due (scan 120 reminders, no list)", 0);
await measure("1 notification → 1 phone", 1);
await measure("3 notifications → 3 pushes (the cap)", 3);
await measure("10 queued, 3 sent, 7 wait", 10);
