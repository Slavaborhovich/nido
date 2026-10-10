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
  ok(await p.evaluate(() => !!document.querySelector(".sw-ghost")), "the old screen slides out while the new one slides in");
  await p.clock.runFor(600);
  ok(await p.evaluate(() => !document.querySelector(".sw-ghost") && !document.getElementById("screen").style.transform), "…and the animation cleans up after itself");

  // finger-following drag: start, move step by step, check mid-drag, then release
  const drag = (x0, xs, release = true) => p.evaluate(async ([x0, xs, release]) => {
    const el = document.elementFromPoint(x0, 400), mk = x => new Touch({ identifier: 1, target: el, clientX: x, clientY: 400 });
    el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [mk(x0)], changedTouches: [mk(x0)] }));
    let mid = null;
    for (const x of xs) { el.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [mk(x)], changedTouches: [mk(x)] })); }
    const sc = document.getElementById("screen"); mid = { tr: sc.style.transform, op: sc.style.opacity };
    if (release) el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], changedTouches: [mk(xs.at(-1))] }));
    return { mid, tab: S.tab };
  }, [x0, xs, release]);
  await p.evaluate(() => go("today"));
  let d = await drag(100, [115, 140, 160], false);
  ok(/translateX\(60px\)/.test(d.mid.tr) && +d.mid.op < 1, `while dragging, the screen follows the finger (${d.mid.tr}, opacity ${d.mid.op})`);
  d = await drag(100, [115, 140, 160]); await p.clock.runFor(500);
  ok(d.tab === "today" && !(await p.evaluate(() => document.getElementById("screen").style.transform)), "a short drag released → springs back to its place");
  d = await drag(300, [285, 250, 200], false);
  ok(/translateX\(-22px\)/.test(d.mid.tr), `no screen that way → only a small rubber-band pull (${d.mid.tr})`);
  await p.evaluate(() => document.getElementById("app").dispatchEvent(new TouchEvent("touchcancel", { bubbles: true, touches: [], changedTouches: [new Touch({ identifier: 1, target: document.body, clientX: 200, clientY: 400 })] })));
  await p.clock.runFor(500);
  d = await drag(80, [100, 160, 240, 330]);
  ok(d.tab === "tasks", "a long drag released → moves to the next screen");
  await p.clock.runFor(600);
  ok(await p.evaluate(() => !document.querySelector(".sw-ghost") && !document.getElementById("screen").style.transform && document.getElementById("screen").style.opacity === ""), "…and ends cleanly in place");
  ok(errs.length === 0, `no errors (${errs.join("; ") || "none"})`);
  await b.close(); console.log(f ? `✘ ${f} FAILED` : "✔ all passed"); process.exit(f ? 1 : 0);
})();
