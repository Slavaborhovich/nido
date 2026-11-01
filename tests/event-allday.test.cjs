// The event window (warm glass): all-day switch, date tiles, who, tasks, files/note panels.
// Local demo mode, no network.   node tests/event-allday.test.cjs
const path = require("path");
let chromium;
try { ({ chromium } = require("playwright")); } catch (e) { ({ chromium } = require("/opt/npm-tools/node_modules/playwright")); }
const FILE = "file://" + path.join(__dirname, "..", "index.html");
let f = 0, n = 0; const ok = (c, m) => { console.log((c ? "  ✔ " : "  ✘ FAIL ") + m); c ? n++ : f++; };

(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.route(/^https?:\/\//, r => r.abort());
  await p.goto(FILE); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(400);
  await p.fill("#user", "slava"); await p.fill("#pass", "1234"); await p.click("#loginBtn"); await p.waitForTimeout(5000);
  await p.evaluate(() => { document.getElementById("splash")?.remove(); window.__t = []; toast = m => __t.push(m); askConfirm = async () => true; go("cal"); });

  // new event from "+": all day by default
  await p.evaluate(() => eventSheet(null, { date: "2026-11-12" })); await p.waitForTimeout(400);
  const s1 = await p.evaluate(() => ({ glass: document.querySelector("#sheetRoot .sheet").classList.contains("evx"), all: document.querySelector("#evAll").checked,
    timeHidden: document.querySelector("#evTime").hidden, t1: document.querySelector("#evT1").innerText.replace(/\s+/g, " ").trim(), t2empty: document.querySelector("#evT2").classList.contains("empty"),
    span: document.querySelector("#evSpan").textContent, rem: document.querySelector("#evRem").textContent }));
  ok(s1.glass && s1.all && s1.timeHidden, "new event: warm-glass window, 'all day' on, no time field");
  ok(s1.t1 === "יום חמישי 12 נובמבר" && s1.t2empty, `start tile shows the date (${s1.t1}); end tile is empty`);
  ok(s1.span === "יום אחד" && s1.rem === "תזכורת: יום לפני, 09:00", "one day · reminder the day before at 09:00");

  await p.fill("#ef input[name=title]", "חופש משפחתי בגליל");
  await p.fill("#ef input[name=end]", "2026-11-14"); await p.dispatchEvent("#ef input[name=end]", "change");
  ok(await p.evaluate(() => document.querySelector("#evSpan").textContent === "3 ימים" && document.querySelector("#evT2 b").textContent === "14" && !document.querySelector("#evEndX").hidden), "end date → '3 ימים', end tile filled, clear button shown");
  const who = await p.evaluate(() => { const k = people()[0]; document.querySelector(`.evx-who input[value="${k}"]`).click(); return k; });
  await p.fill("#ef input[name=place]", "צימר בראש פינה");
  await p.fill("#evNewRow", "חטיפים לדרך"); await p.press("#evNewRow", "Enter"); await p.waitForTimeout(300);
  await p.evaluate(() => { const m = document.querySelector(".ask-list, .askl"); });
  await p.click('#ef [data-pane="note"]'); await p.fill("#ef textarea[name=note]", "לקחת מעילים");
  ok(await p.evaluate(() => !document.querySelector('.evx-pane[data-p="note"]').hidden && document.querySelector('.evx-pane[data-p="files"]').hidden && document.querySelector("#evNoteSum").textContent === "לקחת מעילים"), "note panel opens (files stays closed); the card shows the note");
  await p.click('#ef [data-pane="files"]');
  ok(await p.evaluate(() => document.querySelector('.evx-pane[data-p="note"]').hidden && !document.querySelector('.evx-pane[data-p="files"]').hidden), "one panel open at a time");
  await p.evaluate(() => document.querySelector(".ask-sheet [data-l], .askList [data-l]")?.click());
  await p.click("#ef [type=submit]"); await p.waitForTimeout(900);
  const ev = await p.evaluate(() => DB.events.find(x => x.title === "חופש משפחתי בגליל"));
  ok(ev && ev.time === "" && ev.date === "2026-11-12" && ev.end === "2026-11-14" && ev.who === who && ev.place === "צימר בראש פינה" && ev.note === "לקחת מעילים", "saved: all day, 12–14, who, place, note");
  ok(await p.evaluate(id => DB.tasks.some(t => t.eventId === id && t.title === "חטיפים לדרך" && t.date === "2026-11-12"), ev.id), "the event's task went to the Tasks screen (due on the event day)");

  // switch off → time; switch back on → time cleared
  await p.evaluate(id => eventSheet(DB.events.find(x => x.id === id)), ev.id); await p.waitForTimeout(500);
  ok(await p.evaluate(() => document.querySelector("#evAll").checked && document.querySelector(".evx-who input:checked").value !== ""), "editing: switch on, the saved person is selected");
  await p.click(".evx-sw"); await p.waitForTimeout(100);
  ok(await p.evaluate(() => !document.querySelector("#evTime").hidden && document.querySelector("#ef input[name=time]").value === "09:00" && document.querySelector("#evRem").textContent === "תזכורת: 24 שעות לפני"), "switch off → time field (09:00), reminder 24 h before");
  await p.fill("#ef input[name=time]", "16:30"); await p.dispatchEvent("#ef input[name=time]", "change");
  await p.click("#evEndX");
  ok(await p.evaluate(() => document.querySelector("#evSpan").textContent === "יום אחד · 16:30" && document.querySelector("#evT2").classList.contains("empty")), "clearing the end date → one day at 16:30");
  await p.click("#ef [type=submit]"); await p.waitForTimeout(700);
  const e2 = await p.evaluate(id => DB.events.find(x => x.id === id), ev.id);
  ok(e2.time === "16:30" && e2.end === "", "saved with a time, no end date");
  await p.evaluate(id => eventSheet(DB.events.find(x => x.id === id)), ev.id); await p.waitForTimeout(500);
  ok(await p.evaluate(() => !document.querySelector("#evAll").checked && !document.querySelector("#evTime").hidden), "an event with a time opens with the switch off");
  await p.click(".evx-sw"); await p.click("#ef [type=submit]"); await p.waitForTimeout(700);
  ok(await p.evaluate(id => DB.events.find(x => x.id === id).time === "", ev.id), "switch on again + save → back to all day");

  await p.evaluate(id => eventSheet(DB.events.find(x => x.id === id)), ev.id); await p.waitForTimeout(500);
  ok(await p.evaluate(() => !!document.querySelector("#ef #del")), "editing shows 'delete event'");
  await p.click("#ef #del"); await p.waitForTimeout(700);
  ok(await p.evaluate(id => !DB.events.some(x => x.id === id), ev.id), "delete works");
  ok(errs.length === 0, `no page errors (${errs.join("; ") || "none"})`);
  await b.close(); console.log(`\n${f ? "✘ " + f + " FAILED" : "✔ all passed"} (${n} checks)`); process.exit(f ? 1 : 0);
})();
