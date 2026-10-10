// Splash "קן שנבנה": waits for the real loading (~3 s in all, at most ~5 s), a tap skips it,
// reopening within 10 minutes shows no splash, Light gets the cream version. Local demo mode, no network.
//   node tests/splash.test.cjs
const path = require("path");
let chromium;
try { ({ chromium } = require("playwright")); } catch (e) { ({ chromium } = require("/opt/npm-tools/node_modules/playwright")); }
const FILE = "file://" + path.join(__dirname, "..", "index.html");
let f = 0, n = 0; const ok = (c, m) => { console.log((c ? "  ✔ " : "  ✘ FAIL ") + m); c ? n++ : f++; };

(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.route(/^https?:\/\//, r => r.abort());
  await p.goto(FILE); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(500);
  await p.fill("#user", "slava"); await p.fill("#pass", "1234"); await p.click("#loginBtn");
  const run = js => p.evaluate(js);
  const gone = () => p.evaluate(() => !document.getElementById("splash"));
  const until = async ms => { const t = Date.now(); while (Date.now() - t < ms){ if (await gone()) return Date.now() - t; await p.waitForTimeout(100); } return -1; };
  await p.waitForTimeout(800);
  ok(!(await gone()), "after signing in the nest splash shows");
  const t1 = await until(3500);
  ok(t1 >= 0 && t1 + 800 <= 3600, `data ready (demo) → into the app after ~${((t1 + 800) / 1000).toFixed(1)} s (was 4.3 s)`);

  await run(() => { localStorage.removeItem("nido.seenAt"); const t = Date.now(); window.appProgress = () => Math.min(1, (Date.now() - t) / 3500); playSplash(null); });
  await p.waitForTimeout(2600);
  ok(!(await gone()) && await run(() => parseFloat(document.querySelector("#splash .bar i").style.width) > 50), "still loading → stays, the bar follows the progress");
  ok(await run(() => document.querySelector("#splash .nest").getAnimations().length > 0 || document.querySelectorAll("#splash .fx i").length > 0), "…and the nest giggles meanwhile");
  const t2 = await until(3000);
  ok(t2 >= 0, `loading done → hop → into the app (${((2600 + t2) / 1000).toFixed(1)} s, loading took 3.5 s)`);

  await run(() => { localStorage.removeItem("nido.seenAt"); window.appProgress = () => .3; playSplash(null); });
  const t3 = await until(6000);
  ok(t3 >= 0 && t3 <= 5400, `never more than ~5 s, even if the server is slow (${(t3 / 1000).toFixed(1)} s)`);

  await run(() => { localStorage.removeItem("nido.seenAt"); window.appProgress = () => .3; playSplash(null); });
  await p.waitForTimeout(500); await p.mouse.click(200, 400); await p.waitForTimeout(1500);
  ok(await gone(), "a tap skips it");

  await run(() => { localStorage.setItem("nido.seenAt", String(Date.now() - 3 * 60e3)); playSplash(null); });
  ok(await run(() => !document.getElementById("splash")), "reopened 3 minutes later → no splash at all");

  await run(() => { localStorage.removeItem("nido.seenAt"); Skin.apply("light"); window.appProgress = () => .3; playSplash(null); });
  await p.waitForTimeout(800);
  ok(await run(() => getComputedStyle(document.querySelector("#splash .bg")).backgroundImage.includes("255, 249, 239")), "Nido Light → the cream version");
  ok(errs.length === 0, `no page errors (${errs.join("; ") || "none"})`);
  await b.close(); console.log(`\n${f ? "✘ " + f + " FAILED" : "✔ all passed"} (${n} checks)`); process.exit(f ? 1 : 0);
})();
