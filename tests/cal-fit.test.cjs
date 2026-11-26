// The calendar never gets wider than the screen — every week, month and day of 2026–2027, on narrow and wide phones.
// Local demo mode, no network.   node tests/cal-fit.test.cjs
const path = require("path");
let chromium;
try { ({ chromium } = require("playwright")); } catch (e) { ({ chromium } = require("/opt/npm-tools/node_modules/playwright")); }
const FILE = "file://" + path.join(__dirname, "..", "index.html");
let f = 0, n = 0; const ok = (c, m) => { console.log((c ? "  ✔ " : "  ✘ FAIL ") + m); c ? n++ : f++; };

(async () => {
  const b = await chromium.launch();
  for (const width of [320, 360, 390, 412]) {
    const p = await b.newPage({ viewport: { width, height: 800 } });
    const errs = []; p.on("pageerror", e => errs.push(e.message));
    await p.route(/^https?:\/\//, r => r.abort());
    await p.goto(FILE); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(400);
    await p.fill("#user", "slava"); await p.fill("#pass", "1234"); await p.click("#loginBtn"); await p.waitForTimeout(5000);
    const r = await p.evaluate(() => {
      document.getElementById("splash")?.remove(); Hol.load = () => {};
      const ks = people(), by = {};
      DB.events.push({ id:"fx1", title:"מכבי תל אביב VS עירוני טבריה", date:"2026-12-05", time:"15:00", who:ks[0] },
                     { id:"fx2", title:"חופשה משפחתית ארוכה מאוד בצפון הארץ", date:"2026-12-02", end:"2026-12-04" });
      by["2026-12-04"] = [{ k:"major", n:"חנוכה: א׳ נר" }, { k:"candles", t:"16:15" }];
      by["2026-12-05"] = [{ k:"major", n:"חנוכה: ב׳ נרות" }, { k:"havdalah", t:"17:12" }];
      Hol.data = { at: Date.now(), by };
      go("cal");
      const de = document.documentElement, bad = [];
      const check = lbl => { const t = document.querySelector("#cvTitle");
        if (de.scrollWidth > de.clientWidth + 1 || (t && t.scrollWidth > t.clientWidth + 1)) bad.push(lbl); };
      for (let d = new Date(2026, 0, 4); d < new Date(2028, 0, 1); d.setDate(d.getDate() + 7)) {
        S.calView = "week"; S.calWeek = iso(d); renderCal(); check("week " + iso(d)); }
      for (let m = 0; m < 24; m++) { S.calView = "month"; S.calMonth = new Date(2026, m, 1); renderCal(); check("month " + m); }
      for (let d = new Date(2026, 0, 1); d < new Date(2027, 0, 1); d.setDate(d.getDate() + 1)) {
        S.calView = "day"; S.calSel = iso(d); renderCal(); check("day " + iso(d)); }
      S.calView = "week"; S.calWeek = "2026-11-29"; renderCal();
      return { bad, title: document.querySelector("#cvTitle").textContent, word: getComputedStyle(document.querySelector("#addEv span")).display !== "none" };
    });
    ok(!r.bad.length && !errs.length, `${width}px: no sideways overflow in any week, month or day${r.bad.length ? " — " + r.bad.slice(0, 5).join(", ") : ""}${errs.length ? " — " + errs[0] : ""}`);
    console.log(`     29.11–5.12 header at ${width}px: "${r.title}"${r.word ? " + 'אירוע'" : " (+ only)"}`);
    await p.close();
  }
  await b.close();
  console.log(`\n${n} passed, ${f} failed`); process.exit(f ? 1 : 0);
})();
