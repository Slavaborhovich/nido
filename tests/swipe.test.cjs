// Swipe left/right between screens (RTL), and the cases where a swipe must be ignored. Local demo mode, no network.
//   node tests/swipe.test.cjs
const path = require("path");
let chromium;
try { ({ chromium } = require("playwright")); } catch (e) { ({ chromium } = require("/opt/npm-tools/node_modules/playwright")); }
const FILE = "file://" + path.join(__dirname, "..", "index.html");
let f = 0; const ok = (c, m) => { console.log((c ? "  ✔ " : "  ✘ FAIL ") + m); if (!c) f++; };
(async () => {
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
  await p.clock.install({ time: new Date("2026-10-08T10:30:00+03:00") });
  await p.route(/^https?:\/\//, r => r.abort());
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.goto(FILE); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.clock.runFor(400);
  await p.fill("#user", "slava"); await p.fill("#pass", "1234"); await p.click("#loginBtn"); await p.clock.runFor(6000);
  await p.evaluate(() => document.getElementById("splash")?.remove());
  const swipe = (sel, x0, x1, y0 = 400, y1 = 400, ms = 200) => p.evaluate(async ([sel, x0, x1, y0, y1, ms]) => {
    const el = typeof sel === "string" ? document.querySelector(sel) : document.elementFromPoint(x0, y0);
    const mk = (x, y) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
    el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [mk(x0, y0)], changedTouches: [mk(x0, y0)] }));
    await new Promise(r => setTimeout(r, 0));
    el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [], changedTouches: [mk(x1, y1)] }));
    return S.tab;
  }, [sel, x0, x1, y0, y1, ms]);
  const tab = () => p.evaluate(() => S.tab);
  await p.evaluate(() => go("today"));
  ok(await swipe(null, 100, 300) === "tasks", "swipe right on היום → משימות (next screen)");
  ok(await swipe(null, 100, 300) === "shop", "swipe right again → קניות");
  ok(await swipe(null, 300, 100) === "tasks", "swipe left → back to משימות");
  await p.evaluate(() => go("today"));
  ok(await swipe(null, 300, 100) === "today", "swipe left on the first screen → stays");
  await p.evaluate(() => go("ideas"));
  ok(await swipe(null, 100, 300) === "ideas", "swipe right on the last screen → stays");
  await p.evaluate(() => go("today"));
  ok(await swipe(null, 10, 250) === "today", "a swipe starting at the screen edge (Android back gesture) is ignored");
  ok(await swipe(null, 100, 160) === "today", "a short drag is ignored");
  ok(await swipe(null, 100, 260, 300, 520) === "today", "a mostly vertical drag (scrolling) is ignored");
  await p.evaluate(() => go("shop")); await p.clock.runFor(300);
  const inp = await p.evaluate(() => !!document.querySelector("#app input"));
  if (inp) ok(await swipe("#app input", 300, 80) === "shop", "a swipe inside a text field doesn't switch screens");
  await p.evaluate(() => { go("today"); openProfile(); }); await p.clock.runFor(500);
  ok(await swipe(null, 100, 300, 300, 300) === "today", "with a window open, swiping doesn't switch screens");
  await p.evaluate(() => closeSheet()); await p.clock.runFor(500);
  await p.evaluate(() => go("today"));
  await swipe(null, 100, 300);
  ok(await p.evaluate(() => document.getElementById("screen").classList.contains("sw-l")), "a short slide animation plays");
  ok(errs.length === 0, `no errors (${errs.join("; ") || "none"})`);
  await b.close(); console.log(f ? `✘ ${f} FAILED` : "✔ all passed"); process.exit(f ? 1 : 0);
})();
