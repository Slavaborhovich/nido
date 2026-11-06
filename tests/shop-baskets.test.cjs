// Shopping screen made of lists (Nov 2026): cards per list, take a whole list, tick / missing in the store,
// finish → one total and the rest waits in a new list; add to an open list or a new one; tasks join open lists.
// Local demo mode, no network.   node tests/shop-baskets.test.cjs
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
  await p.evaluate(() => { document.getElementById("splash")?.remove(); window.__t = []; toast = m => __t.push(m); go("shop"); });
  await p.waitForTimeout(400);

  // existing items are gathered into one list per category
  const s0 = await p.evaluate(() => ({ every: DB.shop.every(i => DB.baskets.some(b => b.id === i.bk)), cats: DB.baskets.map(b => b.cat).sort().join(","), cards: document.querySelectorAll(".dCard").length, art: [...document.querySelectorAll(".dArt")].map(i => i.getAttribute("src")) }));
  ok(s0.every && s0.cats === "home,super" && s0.cards === 2, `old items → one list per category (${s0.cats}), a card each`);
  ok(s0.art.includes("icons/shop/super.webp") && s0.art.includes("icons/shop/home.webp"), "cards show the category illustrations");

  // filter by category
  await p.click('[data-cat="home"]'); await p.waitForTimeout(200);
  ok(await p.evaluate(() => document.querySelectorAll(".dCard").length === 1 && /לבית/.test(document.querySelector(".dCard .dTag").textContent)), "category chip filters the lists");
  await p.click('[data-cat=""]'); await p.waitForTimeout(200);

  // add: into an open list
  await p.click("#fab"); await p.waitForTimeout(400);
  await p.fill("#adf input[name=name]", "קפה טורקי");
  const sup = await p.evaluate(() => DB.baskets.find(b => b.cat === "super").id);
  await p.click(`#adf [data-pk="${sup}"]`); await p.click("#adGo"); await p.waitForTimeout(300);
  ok(await p.evaluate(id => DB.shop.some(i => i.name === "קפה טורקי" && i.bk === id), sup), "added to the open supermarket list");

  // add: a new list with a name
  await p.click("#fab"); await p.waitForTimeout(400);
  await p.fill("#adf input[name=name]", "שמפו"); await p.click('#adf [data-pk="new"]'); await p.waitForTimeout(100);
  await p.click('#adf [data-ck="home"]'); await p.fill("#adf input[name=lname]", "קניות לבית ספר"); await p.click("#adGo"); await p.waitForTimeout(300);
  ok(await p.evaluate(() => { const b = DB.baskets.find(x => x.name === "קניות לבית ספר"); return b && b.cat === "home" && bkItems(b).length === 1 && bkItems(b)[0].name === "שמפו"; }), "new list: category + name, one item");
  ok(await p.evaluate(() => document.querySelectorAll(".dCard").length === 3), "three list cards now");

  // take the whole supermarket list
  await p.evaluate(id => document.querySelector(`[data-take="${id}"]`).click(), sup); await p.waitForTimeout(600);
  const s1 = await p.evaluate(id => { const bk = DB.baskets.find(b => b.id === id), t = bkTask(bk); return { by: bk.takenBy, task: !!t && t.kind === "shop", all: bkItems(bk).every(i => i.takenBy === me && i.taskId === t.id), sheet: !!document.querySelector("#sheetRoot .sheet.lw [data-finish]") }; }, sup);
  ok(s1.by === "slava" && s1.task && s1.all && s1.sheet, "אני לוקח: whole list is mine, one shopping task, the in-store window opens");

  // in the store: tick two, one wasn't there
  const n0 = await p.evaluate(id => bkItems(DB.baskets.find(b => b.id === id)).length, sup);
  await p.evaluate(() => document.querySelectorAll("#sheetRoot [data-got]")[0].click()); await p.waitForTimeout(150);
  await p.evaluate(() => document.querySelectorAll("#sheetRoot [data-got]")[0].click()); await p.waitForTimeout(150);
  await p.evaluate(() => document.querySelector("#sheetRoot [data-miss]").click()); await p.waitForTimeout(150);
  ok(await p.evaluate(() => document.querySelector("#sheetRoot .lw-prog span").textContent.trim().startsWith("2 /") && document.querySelectorAll("#sheetRoot .lw-it.got").length === 2 && document.querySelectorAll("#sheetRoot .lw-it.miss").length === 1), "ticked 2, one marked 'חסר', progress 2/N");

  // finish → one total, rest in a new supermarket list
  await p.click("#sheetRoot [data-finish]"); await p.waitForTimeout(800);
  const s2 = await p.evaluate(() => { const w = document.querySelector(".bxp-scrim.show"); return w && [...w.querySelectorAll(".stats b")].map(x => x.textContent).join("/"); });
  ok(s2 === `2/${n0 - 2}`, `סיימתי → "כמה יצא בסך הכל?" with 2 bought / ${n0 - 2} waiting (${s2})`);
  await p.fill("#bxA", "120"); await p.click(".bxp .go"); await p.waitForTimeout(500);
  const s3 = await p.evaluate(id => ({ gone: !DB.baskets.some(b => b.id === id), rest: DB.baskets.filter(b => b.cat === "super").map(b => bkItems(b).length), free: DB.baskets.filter(b => b.cat === "super").every(b => !b.takenBy && bkItems(b).every(i => !i.takenBy && !i.got)), exp: Money.L().ex.length }), sup);
  ok(s3.gone && s3.rest.length === 1 && s3.rest[0] === n0 - 2 && s3.free, "the list went away; what wasn't bought waits in a new supermarket list");
  ok(s3.exp === 1, "one expense for the whole list");

  // give a list back
  const hb = await p.evaluate(() => DB.baskets.find(b => b.name === "קניות לבית ספר").id);
  await p.evaluate(id => { takeBasket(DB.baskets.find(b => b.id === id)); dropBasket(DB.baskets.find(b => b.id === id)); }, hb);
  ok(await p.evaluate(id => { const bk = DB.baskets.find(b => b.id === id); return !bk.takenBy && !bkTask(bk) && bkItems(bk).every(i => !i.takenBy); }, hb), "'אני כבר לא לוקח' gives the list back, the task goes away");

  // a task can join an open list
  await p.evaluate(() => { go("tasks"); taskSheet(); }); await p.waitForTimeout(400);
  await p.fill("#tf input[name=title]", "לקנות מברשת שיניים");
  ok(await p.evaluate(id => !!document.querySelector(`#tkBuy [data-bb="${id}"]`), hb), "task card offers the open lists too");
  await p.evaluate(id => document.querySelector(`#tkBuy [data-bb="${id}"]`).click(), hb);
  await p.click("#tf button[type=submit]"); await p.waitForTimeout(300);
  ok(await p.evaluate(id => DB.shop.some(i => i.name === "מברשת שיניים" && i.bk === id && i.fromTask), hb), "…and its item went into that list");

  // view-only: no take / add
  await p.evaluate(() => { USERS[me].role = "viewer"; go("shop"); renderShop(); });
  ok(await p.evaluate(() => !document.querySelector("[data-take]") && !document.querySelector("#fab")), "view-only: no 'אני לוקח', no ＋");
  await p.evaluate(() => { USERS[me].role = "admin"; });

  ok(!errs.length, "no page errors" + (errs.length ? ": " + errs.join(" | ") : ""));
  await b.close(); console.log(`\n${n} passed, ${f} failed`); process.exit(f ? 1 : 0);
})();
