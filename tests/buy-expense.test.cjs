// Tasks → shopping → expenses: "לקנות" suggestion in the task window, linked item in the list,
// "כמה עלה?" after a single purchase, one total after a shopping round, skip.
// Local demo mode, no network.   node tests/buy-expense.test.cjs
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
  await p.evaluate(() => { document.getElementById("splash")?.remove(); window.__t = []; toast = m => __t.push(m); go("tasks"); });
  const exps = () => p.evaluate(() => Money.L().ex);

  // 1. task window: suggestion appears while typing "לקנות …"
  await p.evaluate(() => taskSheet()); await p.waitForTimeout(400);
  ok(await p.evaluate(() => document.querySelector("#tkBuy").hidden), "no suggestion before typing");
  await p.fill("#tf input[name=title]", "לקנות סוללות לשלט");
  ok(await p.evaluate(() => { const x = document.querySelector("#tkBuy"); return !x.hidden && /נשמע כמו קנייה/.test(x.textContent) && x.querySelectorAll("[data-bl]").length >= 2; }), "suggestion card with the lists");
  await p.click("#tkBuy [data-bl=home]"); await p.click("#tkBuy [data-yes]");
  ok(await p.evaluate(() => document.querySelector("#tkBuy").classList.contains("done") && /רשימת לבית/.test(document.querySelector("#tkBuy").textContent)), "after 'הוסף לרשימה': one line 'ייכנס לרשימת לבית'");
  await p.click("#tf button[type=submit]"); await p.waitForTimeout(300);
  ok(await p.evaluate(() => !document.querySelector(".cfm-scrim")), "no extra popup on save");
  const tk = await p.evaluate(() => { const t = DB.tasks.find(x => x.title === "לקנות סוללות לשלט"); const it = DB.shop.find(i => i.fromTask === t.id); return { buy:t.buy, it: it && it.name, list: it && it.list }; });
  ok(tk.buy === "home" && tk.it === "סוללות לשלט" && tk.list === "home", "task linked to a shopping item in לבית");

  // "לא, תודה" → plain task
  await p.evaluate(() => taskSheet()); await p.waitForTimeout(400);
  await p.fill("#tf input[name=title]", "לקנות כרטיסים להופעה"); await p.click("#tkBuy [data-no]");
  ok(await p.evaluate(() => document.querySelector("#tkBuy").hidden), "'לא, תודה' hides the suggestion");
  await p.click("#tf button[type=submit]"); await p.waitForTimeout(300);
  ok(await p.evaluate(() => { const t = DB.tasks.find(x => x.title === "לקנות כרטיסים להופעה"); return t && !t.buy && !DB.shop.some(i => i.fromTask === t.id); }), "…and the task stays only a task");

  // 2. shopping list shows the link
  await p.evaluate(() => { ShopUI.set("home"); go("shop"); }); await p.waitForTimeout(300);
  ok(await p.evaluate(() => /מקושר למשימה/.test(document.querySelector("#screen .sh-card:not(.closed)").textContent)), "the item shows 'מקושר למשימה' in the list");

  // 3. single purchase → "כמה עלה?"
  await p.evaluate(() => completeTask(DB.tasks.find(x => x.title === "לקנות סוללות לשלט"))); await p.waitForTimeout(700);
  const s3 = await p.evaluate(() => { const w = document.querySelector(".bxp-scrim"); return w && { t: w.querySelector("#bxT").textContent, lb: w.querySelector("label.lb").textContent, cat: w.querySelector("#bxC .on").textContent, stats: !!w.querySelector(".stats") }; });
  ok(s3 && s3.t === "סוללות לשלט" && s3.lb === "כמה עלה?" && !s3.stats, "single item: 'כמה עלה?' for 'סוללות לשלט'");
  ok(s3 && s3.cat === "לבית", `category filled from the list (${s3 && s3.cat})`);
  await p.click(".bxp .go"); await p.waitForTimeout(200);
  ok(await p.evaluate(() => /מה הסכום/.test(document.querySelector("#bxE").textContent)), "no amount → asks for it");
  await p.fill("#bxA", "24.90"); await p.click(".bxp .go"); await p.waitForTimeout(500);
  let ex = await exps();
  ok(ex.length === 1 && ex[0].amount === 2490 && ex[0].cat === "home" && ex[0].desc === "סוללות לשלט" && ex[0].payer === "slava", "saved: ₪24.90, לבית, paid by me");
  ok(await p.evaluate(() => !document.querySelector(".bxp-scrim") || !document.querySelector(".bxp-scrim.show")), "window closed");

  // 4. shopping round → one total
  await p.evaluate(() => { DB.shop = DB.shop.filter(i => shopKey(i.list) !== "super");
    ["חלב", "לחם", "ביצים"].forEach(nm => DB.shop.push({ id:uid(), name:nm, qty:"", note:"", takenBy:null, taskId:null, list:"super" }));
    DB.shop.filter(i => i.list === "super").forEach(i => takeInto(i));
    const miss = DB.shop.find(i => i.name === "לחם"); releaseItem(miss); miss.missing = { at:Date.now() + 1, by:me, where:"super", tell:false };
    save(); completeTask(myShopTask("super")); });
  await p.waitForTimeout(700);
  const s4 = await p.evaluate(() => { const w = document.querySelector(".bxp-scrim.show"); return w && { t: w.querySelector("#bxT").textContent, lb: w.querySelector("label.lb").textContent, st: [...w.querySelectorAll(".stats b")].map(x => x.textContent).join("/"), cat: w.querySelector("#bxC .on").textContent }; });
  ok(s4 && s4.lb === "כמה יצא בסך הכל?" && s4.st === "2/1", `round: total asked once, 2 bought / 1 missing (${s4 && s4.st})`);
  ok(s4 && s4.cat === "סופר ומזון", "round category from the list: סופר ומזון");
  await p.click("#bxP"); ok(await p.evaluate(() => document.querySelector("#bxP b").textContent !== "סלבה"), "'מי שילם' switches");
  await p.fill("#bxA", "486.30"); await p.click(".bxp .go"); await p.waitForTimeout(500);
  ex = await exps();
  ok(ex.length === 2 && ex.some(e => e.amount === 48630 && e.cat === "food" && e.from === "shop"), "one expense for the whole round (₪486.30)");

  // 5. skip saves nothing
  await p.evaluate(() => { const t = { id:uid(), kind:"task", title:"לקנות נורה", assignee:null, date:null, time:null, repeat:"none", done:false, buy:"home", created:Date.now() }; DB.tasks.push(t); syncBuy(t); completeTask(t); });
  await p.waitForTimeout(700); await p.click(".bxp .skip"); await p.waitForTimeout(400);
  ok((await exps()).length === 2 && !(await p.evaluate(() => document.querySelector(".bxp-scrim"))), "'דלג' closes, nothing saved");

  // 6. an item already in someone's round is not asked separately
  await p.evaluate(() => { const t = { id:uid(), kind:"task", title:"לקנות סבון", assignee:null, date:null, time:null, repeat:"none", done:false, buy:"super", created:Date.now() }; DB.tasks.push(t); syncBuy(t);
    takeInto(DB.shop.find(i => i.id === t.shopItemId)); completeTask(t); });
  await p.waitForTimeout(700);
  ok(!(await p.evaluate(() => document.querySelector(".bxp-scrim"))), "item already taken into a round → no separate question");

  // 7. view-only member: never asked
  await p.evaluate(() => { USERS[me].role = "viewer"; const t = { id:uid(), kind:"task", title:"לקנות מטריה", assignee:null, date:null, time:null, repeat:"none", done:false, buy:"home", created:Date.now() }; DB.tasks.push(t); syncBuy(t); completeTask(t); USERS[me].role = "admin"; });
  await p.waitForTimeout(700);
  ok(!(await p.evaluate(() => document.querySelector(".bxp-scrim"))), "view-only: no question");

  ok(!errs.length, "no page errors" + (errs.length ? ": " + errs.join(" | ") : ""));
  await b.close(); console.log(`\n${n} passed, ${f} failed`); process.exit(f ? 1 : 0);
})();
