// קניות: one list open at a time + the row of list chips. Local demo mode, no network.   node tests/shop-accordion.test.cjs
const path = require("path");
let chromium;
try { ({ chromium } = require("playwright")); } catch (e) { ({ chromium } = require("/opt/npm-tools/node_modules/playwright")); }
const FILE = "file://" + path.join(__dirname, "..", "index.html");
let f = 0, n = 0; const ok = (c, m) => { console.log((c ? "  ✔ " : "  ✘ FAIL ") + m); c ? n++ : f++; };
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 360, height: 740 } });
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.route(/^https?:\/\//, r => r.abort());
  await p.goto(FILE); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(400);
  await p.fill("#user", "slava"); await p.fill("#pass", "1234"); await p.click("#loginBtn"); await p.waitForTimeout(4500);
  await p.evaluate(() => { document.getElementById("splash")?.remove(); window.__t = []; toast = m => __t.push(m);
    // a family with five lists, so the chip row must scroll
    DB.shoplists = SHOP_DEF.map(d => ({ ...d })).concat([{ id:"ph", name:"סופר פארם", to:"סופר פארם", pic:"pill", color:"pink" }, { id:"cl", name:"בגדים", to:"בגדים", pic:"tshirt", color:"purple" }]);
    DB.shop.push({ id:uid(), name:"סימילאק 2", qty:"", note:"", takenBy:null, taskId:null, list:"ph" });
    save(); go("shop"); });
  await p.waitForTimeout(400);
  const R = (js, a) => p.evaluate(js, a);
  const openCards = () => R(() => [...document.querySelectorAll(".sh-card:not(.closed)")].map(c => c.dataset.sl));

  ok(await R(() => [...document.querySelectorAll(".sh-chip")].map(c => c.dataset.chip).join() === "super,home,noam,ph,cl"), "a chip for every list, in the family's order");
  ok(await R(() => [...document.querySelectorAll(".sh-chip")].every(c => +c.querySelector("b").textContent === DB.shop.filter(i => shopKey(i.list) === c.dataset.chip).length)), "each chip counts its list's items");
  ok((await openCards()).join() === "super", "first visit: only the first list is open");
  ok(await R(() => document.querySelector(".sh-card").dataset.sl === "super" && document.querySelector('.sh-chip[data-chip="super"]').classList.contains("on")), "the open list is first and its chip is highlighted");
  ok(await R(() => { const r = document.querySelector(".sh-chips"); return r.scrollWidth > r.clientWidth && getComputedStyle(r).overflowX === "auto" && r.hasAttribute("data-noswipe"); }), "on a narrow phone the chip row scrolls sideways (and doesn't switch screens)");

  // switch with a chip
  await p.click('.sh-chip[data-chip="ph"]', { force: true }); await p.waitForTimeout(400);
  ok((await openCards()).join() === "ph", "a chip opens its list and closes the one before");
  ok(await R(() => document.querySelector(".sh-card").dataset.sl === "ph" && document.querySelectorAll(".sh-card").length === 5), "the opened list moves up; all five lists stay on the screen");
  ok(await R(() => localStorage.getItem("nido.shopOpen") === "ph"), "the choice is remembered on this phone");
  // switch with a closed card
  await p.click('.sh-card[data-sl="home"] .sh-hd'); await p.waitForTimeout(400);
  ok((await openCards()).join() === "home", "tapping a closed card opens it and closes the other");
  // never more than one, also when adding
  await p.click('[data-plus="home"]'); await p.waitForTimeout(200);
  await p.fill('.sh-add input[name=name]', "מנורה"); await p.press('.sh-add input[name=name]', "Enter"); await p.waitForTimeout(300);
  ok(await R(() => DB.shop.some(i => i.name === "מנורה" && i.list === "home")) && (await openCards()).join() === "home", "adding an item works and keeps just that list open");
  await p.click('.sh-chip[data-chip="super"]', { force: true }); await p.waitForTimeout(300);
  ok(!(await R(() => !!document.querySelector(".sh-add"))) && (await openCards()).join() === "super", "switching lists closes the half-open add box of the other list");

  // "אני לוקח" across two lists still makes one task
  await R(() => document.querySelector('[data-sl="super"] .box').click()); await p.waitForTimeout(200);
  await p.click('.sh-chip[data-chip="ph"]', { force: true }); await p.waitForTimeout(300);
  ok(await R(() => S.take && S.takeSel.size === 1), "the pick from the first list survives switching lists");
  await R(() => document.querySelector('[data-sl="ph"] .box').click()); await p.waitForTimeout(200);
  await R(() => document.getElementById("takeOk").click()); await p.waitForTimeout(300);
  ok(await R(() => { const t = myShopTask(); return t && DB.shop.filter(i => i.taskId === t.id).map(i => shopKey(i.list)).sort().join() === "ph,super"; }), "✓ from two lists → one shopping task with both");
  ok(await R(() => DB.shop.filter(i => i.takenBy === me).length === 2), "taken items stay on the lists until the task is done");

  // close all, then a deleted list falls back
  await p.click('.sh-card[data-sl="ph"] .sh-hd'); await p.waitForTimeout(300);
  ok((await openCards()).length === 0 && await R(() => !document.querySelector(".sh-chip.on")), "the open list can be closed (nothing open)");
  await R(() => { localStorage.setItem("nido.shopOpen", "gone"); renderShop(); }); await p.waitForTimeout(200);
  ok((await openCards()).join() === "super", "a remembered list that no longer exists → the first list opens");

  // nothing hidden behind the bar: the last card can scroll above the bottom navigation
  await R(() => window.scrollTo(0, 1e6)); await p.waitForTimeout(300);
  ok(await R(() => { const last = [...document.querySelectorAll(".sh-card")].pop().getBoundingClientRect(), nav = document.querySelector("nav.tabs").getBoundingClientRect(); return last.bottom <= nav.top; }), "the last list scrolls clear of the bottom bar");

  // coupons + survey still open
  await R(() => document.querySelector('[data-list="coupons"]').click()); await p.waitForTimeout(300);
  ok(await R(() => S.shopList === "coupons" && !document.querySelector(".sh-chips")), "קופונים opens (no list row there)");
  await R(() => document.querySelector('[data-list="survey"]').click()); await p.waitForTimeout(300);
  ok(await R(() => S.shopList === "survey" && !!document.querySelector(".sv-card")), "סקר שוק opens");

  ok(!errs.length, `no page errors (${errs.join(" | ") || "none"})`);
  await b.close();
  console.log(f ? `\n✘ ${f} failed, ${n} passed` : `\n✔ all passed (${n} checks)`); process.exit(f ? 1 : 0);
})();
