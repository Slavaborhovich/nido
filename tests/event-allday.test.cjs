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
    timeHidden: document.querySelector("#evTime").hidden, t1: document.querySelector("#evT1").innerText.replace(/\s+/g, " ").trim(), t2empty: document.querySelector("#evTiles").classList.contains("one") && getComputedStyle(document.querySelector("#evT2")).display !== "none" && document.querySelector("#evT2").offsetParent === null && !document.querySelector("#evAddEnd").hidden,
    span: document.querySelector("#evSpan").textContent, rem: document.querySelector("#evRem").textContent }));
  ok(s1.glass && s1.all && s1.timeHidden, "new event: warm-glass window, 'all day' on, no time field");
  ok(s1.t1 === "יום חמישי 12 נובמבר" && s1.t2empty, `one tile with the date (${s1.t1}); no empty end tile, a "+ עד תאריך" button instead`);
  ok(s1.span === "יום אחד" && s1.rem === "תזכורת: יום לפני, 09:00", "one day · reminder the day before at 09:00");

  await p.fill("#ef input[name=title]", "חופש משפחתי בגליל");
  await p.fill("#evEndPick", "2026-11-14"); await p.dispatchEvent("#evEndPick", "change");
  ok(await p.evaluate(() => document.querySelector("#evSpan").textContent === "3 ימים" && document.querySelector("#evT2 b").textContent === "14" && !document.querySelector("#evTiles").classList.contains("one") && document.querySelector("#evAddEnd").hidden), "'+ עד תאריך' → second tile appears, '3 ימים'");
  await p.click("#evRemBtn");
  ok(await p.evaluate(() => [...document.querySelectorAll("#evRems [data-rem]")].map(b => b.textContent).join("|") === "יום לפני, 09:00|באותו בוקר, 07:00|יומיים לפני, 09:00|שבוע לפני, 09:00|בלי תזכורת"), "reminder button opens the all-day choices");
  await p.click('#evRems [data-rem="2d"]');
  ok(await p.evaluate(() => document.querySelector("#evRem").textContent === "תזכורת: יומיים לפני, 09:00" && document.querySelector("#evRems").hidden), "picking 'יומיים לפני' shows it and closes the list");
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
  ok(ev && ev.time === "" && ev.date === "2026-11-12" && ev.end === "2026-11-14" && ev.remind === "2d" && ev.who === who && ev.place === "צימר בראש פינה" && ev.note === "לקחת מעילים", "saved: all day, 12–14, reminder, who, place, note");
  ok(await p.evaluate(id => DB.tasks.some(t => t.eventId === id && t.title === "חטיפים לדרך" && t.date === "2026-11-12"), ev.id), "the event's task went to the Tasks screen (due on the event day)");

  // switch off → time; switch back on → time cleared
  // week view: an all-day / multi-day event is one bar across the whole day, not a slot
  await p.evaluate(() => { closeSheet(); S.calView = "week"; S.calWeek = iso(startOfWeek(parse("2026-11-12"))); go("cal"); }); await p.waitForTimeout(500);
  const wk = await p.evaluate(id => ({ bars: [...document.querySelectorAll(`.cv-wide[data-id="${id}"]`)].map(b => b.querySelector("small").textContent), inSlot: !!document.querySelector(`.cv-x[data-id="${id}"]`), col: document.querySelector(`.cv-wide[data-id="${id}"]`)?.style.gridColumn }), ev.id);
  ok(wk.bars.join() === "1/3,2/3,3/3" && !wk.inSlot && /2 \/ -1/.test(wk.col), `week: a full-width bar on each of the 3 days (${wk.bars})`);
  await p.click(`.cv-wide[data-id="${ev.id}"]`); await p.waitForTimeout(400);
  ok(await p.evaluate(() => !!document.querySelector(".evv")), "tapping the bar opens the event");
  await p.evaluate(() => closeSheet()); await p.waitForTimeout(300);
  await p.evaluate(id => eventSheet(DB.events.find(x => x.id === id)), ev.id); await p.waitForTimeout(500);
  ok(await p.evaluate(() => document.querySelector("#evAll").checked && document.querySelector(".evx-who input:checked").value !== ""), "editing: switch on, the saved person is selected");
  await p.click(".evx-sw"); await p.waitForTimeout(100);
  ok(await p.evaluate(() => !document.querySelector("#evTime").hidden && document.querySelector("#ef input[name=time]").value === "09:00" && document.querySelector("#evTimeTxt").textContent === "09:00" && document.querySelector("#evRem").textContent === "תזכורת: יומיים לפני"), "switch off → time (09:00) in the same style; the reminder choice is kept");
  await p.fill("#ef input[name=time]", "16:30"); await p.dispatchEvent("#ef input[name=time]", "change");
  await p.click("#evEndX");
  ok(await p.evaluate(() => document.querySelector("#evSpan").textContent === "יום אחד · 16:30" && document.querySelector("#evTimeTxt").textContent === "16:30" && document.querySelector("#evTiles").classList.contains("one")), "clearing the end date → one tile, one day at 16:30");
  await p.click("#evRemBtn"); await p.click('#evRems [data-rem="3h"]');
  await p.click("#ef [type=submit]"); await p.waitForTimeout(700);
  const e2 = await p.evaluate(id => DB.events.find(x => x.id === id), ev.id);
  ok(e2.time === "16:30" && e2.end === "" && e2.remind === "3h", "saved with a time, no end date, reminder 3 h before");
  const plan = await p.evaluate(id => EvRemind.plan(DB.events.find(x => x.id === id)).map(r => r.tag + ":" + new Date(r.at((d, t) => { const [h, m] = t.split(":").map(Number); const x = parse(d); x.setHours(h, m, 0, 0); return x.getTime(); })).getHours()), ev.id);
  ok(plan.join() === "er:13", `reminder plan follows the choice (${plan})`);
  // the view window is the new style too
  await p.evaluate(id => eventView(DB.events.find(x => x.id === id)), ev.id); await p.waitForTimeout(500);
  const v = await p.evaluate(() => ({ glass: document.querySelector("#sheetRoot .sheet").classList.contains("evx"), title: document.querySelector(".evx-title h2").textContent, tag: document.querySelector(".evx-tag").textContent.trim(), one: document.querySelector(".evv .evx-tiles").classList.contains("one"), rem: document.querySelector(".evv .evx-rem").textContent.trim(), edit: !!document.querySelector("#edit") }));
  ok(v.glass && v.title === "חופש משפחתי בגליל" && v.tag === "16:30" && v.one && v.rem === "תזכורת: 3 שעות לפני" && v.edit, "tapping the event opens the new-style view (time, one tile, reminder, edit)");
  await p.click("#edit"); await p.waitForTimeout(500);
  ok(await p.evaluate(() => !document.querySelector("#evAll").checked && !document.querySelector("#evTime").hidden), "'עריכה' opens the form; an event with a time has the switch off");
  await p.click(".evx-sw"); await p.click("#ef [type=submit]"); await p.waitForTimeout(700);
  ok(await p.evaluate(id => DB.events.find(x => x.id === id).time === "", ev.id), "switch on again + save → back to all day");

  await p.evaluate(id => eventSheet(DB.events.find(x => x.id === id)), ev.id); await p.waitForTimeout(500);
  ok(await p.evaluate(() => !!document.querySelector("#ef #del")), "editing shows 'delete event'");
  await p.click("#ef #del"); await p.waitForTimeout(700);
  ok(await p.evaluate(id => !DB.events.some(x => x.id === id), ev.id), "delete works");
  ok(errs.length === 0, `no page errors (${errs.join("; ") || "none"})`);
  await b.close(); console.log(`\n${f ? "✘ " + f + " FAILED" : "✔ all passed"} (${n} checks)`); process.exit(f ? 1 : 0);
})();
