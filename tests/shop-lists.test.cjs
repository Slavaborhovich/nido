// קניות: one tab with three cards (סופר / לבית / לנועם), add inside a card, fold a card, move an item between lists,
// "לקנות …" in an event/idea/task offers all three lists. Local demo mode, no network.   node tests/shop-lists.test.cjs
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
  await p.fill("#user", "slava"); await p.fill("#pass", "1234"); await p.click("#loginBtn"); await p.waitForTimeout(4500);
  await p.evaluate(() => { document.getElementById("splash")?.remove(); window.__t = []; toast = m => __t.push(m); go("shop"); });
  await p.waitForTimeout(400);
  const R = (js, a) => p.evaluate(js, a);
  ok(await R(() => [...document.querySelectorAll(".seg.lists [data-list]")].map(x => x.dataset.list).join() === "shop,survey,coupons"), "the bar is קניות · סקר שוק · קופונים");
  ok(await R(() => [...document.querySelectorAll(".sh-card")].map(x => x.dataset.sl).join() === "super,home,noam"), "three cards: סופר, לבית, לנועם");
  const cnt = await R(() => ({ s: document.querySelectorAll('[data-sl="super"] .item').length, h: document.querySelectorAll('[data-sl="home"] .item').length, all: DB.shop.length }));
  ok(cnt.s + cnt.h === cnt.all && cnt.all > 0, `every existing item shows in its own card (סופר ${cnt.s}, לבית ${cnt.h})`);
  // add inside לנועם
  await p.click('[data-chip="noam"]'); await p.waitForTimeout(300);
  await p.click('[data-plus="noam"]'); await p.waitForTimeout(200);
  await p.fill('.sh-add input[name=name]', "חיתולים מידה 4"); await p.fill('.sh-add input[name=qty]', "2 חבילות"); await p.press('.sh-add input[name=name]', "Enter"); await p.waitForTimeout(300);
  ok(await R(() => { const i = DB.shop.find(x => x.name === "חיתולים מידה 4"); return i && i.list === "noam" && i.qty === "2 חבילות" && !!document.querySelector('[data-sl="noam"] .item'); }), "＋ inside לנועם adds the item to לנועם");
  // fold
  await p.click('[data-fold="home"]'); await p.waitForTimeout(300);
  ok(await R(() => !document.querySelector('[data-sl="home"]').classList.contains("closed") && document.querySelectorAll(".sh-card:not(.closed)").length === 1 && localStorage.getItem("nido.shopOpen") === "home"), "opening a card closes the others (and is remembered on this phone)");
  await p.click('[data-fold="home"]'); await p.waitForTimeout(300);
  ok(await R(() => document.querySelectorAll(".sh-card:not(.closed)").length === 0), "the open card can be closed too");
  // move between lists
  await R(() => itemSheet(DB.shop.find(x => x.name === "חיתולים מידה 4"))); await p.waitForTimeout(400);
  await R(() => document.querySelector('#if input[name=list][value="home"]').click()); await p.click("#if [type=submit]"); await p.waitForTimeout(400);
  ok(await R(() => DB.shop.find(x => x.name === "חיתולים מידה 4").list === "home" && !!document.querySelector('[data-sl="home"] .item[data-id="' + DB.shop.find(x => x.name === "חיתולים מידה 4").id + '"]')), "an item can move to another list from its window");
  // take across cards
  await R(() => { document.querySelector('[data-sl="super"] .box').click(); }); await p.waitForTimeout(200);
  await R(() => { document.querySelector('[data-sl="home"] .box:not(.on)').click(); }); await p.waitForTimeout(200);
  await R(() => document.getElementById("takeOk").click()); await p.waitForTimeout(300);
  ok(await R(() => { const ts = DB.tasks.filter(t => t.kind === "shop" && !t.done && t.assignee === me); const of = k => ts.find(t => t.list === k);
    return ts.length === 2 && of("super").title === "קניות בסופר" && of("home").title === "קניות לבית"
      && DB.shop.filter(i => i.taskId === of("super").id).every(i => i.list === "super") && DB.shop.filter(i => i.taskId === of("home").id).every(i => i.list === "home"); }), "✓ items from two cards → a shopping task per list (קניות בסופר, קניות לבית)");
  // askList: three lists
  let lists = null;
  await R(() => { window.__al = askList("לקנות מוצץ"); }); await p.waitForTimeout(300);
  lists = await R(() => [...document.querySelectorAll(".cfm [data-l]")].map(x => x.dataset.l + ":" + x.textContent.trim()).join());
  await R(() => document.querySelector('.cfm [data-l="noam"]').click());
  ok(lists === "super:סופר,home:לבית,noam:לנועם" && await R(() => __al) === "noam", `"לקנות …" asks: ${lists}`);
  // event task → לנועם
  await R(() => { askList = async () => "noam"; eventSheet(null, { date: iso(new Date()) }); }); await p.waitForTimeout(400);
  await p.fill("#ef input[name=title]", "יום הולדת לנועם"); await p.fill("#evNewRow", "לקנות בלונים"); await p.press("#evNewRow", "Enter"); await p.waitForTimeout(300);
  const lbl = await R(() => document.querySelector("#evRows .st-cart").getAttribute("aria-label"));
  await p.click("#ef [type=submit]"); await p.waitForTimeout(500);
  ok(lbl === "ברשימת לנועם" && await R(() => { const i = DB.shop.find(x => x.name === "בלונים"); return i && i.list === "noam" && !!i.fromTask; }), `an event task "לקנות בלונים" → לנועם (${lbl})`);
  const ev = await R(() => DB.events.find(x => x.title === "יום הולדת לנועם").id);
  await R(id => eventView(DB.events.find(x => x.id === id)), ev); await p.waitForTimeout(400);
  ok(await R(() => /לנועם/.test(document.querySelector("#evTasks .st-cart")?.textContent || "")), "the event window shows the task is in לנועם");
  ok(errs.length === 0, `no page errors (${errs.join("; ") || "none"})`);
  await b.close(); console.log(`\n${f ? "✘ " + f + " FAILED" : "✔ all passed"} (${n} checks)`); process.exit(f ? 1 : 0);
})();
