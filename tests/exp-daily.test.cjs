// הוצאות → סקירה: daily budget card. per day = (budget − spent before today − expected) ÷ days left including today;
// "אפשר להוציא היום" = per day − spent today; over → "חרגנו היום ב"; nothing left → "אין יתרה"; hidden without a budget or in a past month.
//   node tests/exp-daily.test.cjs
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
  await p.fill("#user", "slava"); await p.fill("#pass", "1234"); await p.click("#loginBtn"); await p.waitForTimeout(4000);
  const R = (fn, a) => p.evaluate(fn, a);
  await R(() => { document.getElementById("splash")?.remove(); });

  // budget ₪10,000; ₪4,000 spent before today (if today is the 1st it is today), ₪100 today, ₪500 expected later this month
  const setup = (budget, before, todayAmt) => R(([budget, before, todayAmt]) => {
    const t = iso(new Date()), m = t.slice(0, 7), day = +t.slice(8, 10), dim = new Date(+m.slice(0, 4), +m.slice(5, 7), 0).getDate(), d = k => m + "-" + String(k).padStart(2, "0");
    const ex = [];
    if (day > 1) ex.push({ id: "a", amount: before, desc: "קודם", cat: "food", payer: "slava", date: d(1), month: m, by: "slava", at: 1 });
    ex.push({ id: "b", amount: todayAmt, desc: "היום", cat: "food", payer: "slava", date: t, month: m, by: "slava", at: 2 });
    if (day < dim) ex.push({ id: "c", amount: 50000, desc: "צפוי", cat: "bills", payer: "slava", date: d(dim), month: m, by: "slava", at: 3 });
    localStorage.setItem("nido.money", JSON.stringify({ ex, plans: [], settings: budget ? { budget: { total: budget, cats: {} } } : null }));
    Money.m = null; Money.month = null; S.moneyView = "over"; go("money");
    const left = dim - day + 1, beforeSpent = day > 1 ? before : 0, up = day < dim ? 50000 : 0, per = (budget - beforeSpent - up) / left;
    return { per, can: per - todayAmt };
  }, [budget, before, todayAmt]);
  const card = () => R(() => { const c = document.querySelector(".mn-daily"); return c && { label: c.querySelector(".k span").textContent, big: c.querySelector(".k b").textContent, small: c.querySelector(".k small").textContent, today: c.querySelector(".td .r b").textContent, bar: c.querySelector(".bar i")?.className.trim() }; });

  let x = await setup(1000000, 400000, 10000); await p.waitForTimeout(300);
  let c = await card(), exp = await R(([a, b]) => [ilsR(a), ilsR(b)], [x.can, x.per]);
  ok(c && c.label === "אפשר להוציא היום" && c.big === exp[0] && c.small.includes(exp[1]) && c.today === "₪100", `under the daily budget: "${c && c.big}" of ${exp[1]} a day, today ₪100`);
  ok(await R(() => !!document.querySelector(".mn-hero .mn-daily")), "today's budget sits in the ring card");

  x = await setup(1000000, 400000, Math.round(x.per) + 30000); await p.waitForTimeout(300);
  c = await card(); exp = await R(a => ilsR(Math.abs(a)), x.can);
  ok(c && c.label === "חרגנו היום ב" && c.big === exp && c.bar === "hi", `over today's share: "חרגנו היום ב ${c && c.big}", red bar`);

  await setup(1000000, 1200000, 1000); await p.waitForTimeout(300);
  c = await card(); const day1 = await R(() => +iso(new Date()).slice(8, 10) === 1);
  ok(day1 || (c && c.big === "אין יתרה"), "budget already used up → \"אין יתרה\"");

  await setup(0, 400000, 10000); await p.waitForTimeout(300);
  ok(!(await card()), "no budget → no daily card");
  await setup(1000000, 400000, 10000); await R(() => { Money.month = addMonth(Money.m, -1); renderMoney(); }); await p.waitForTimeout(300);
  ok(!(await card()), "a past month → no daily card");

  ok(!errs.length, "no page errors" + (errs.length ? ": " + errs.join(" | ") : ""));
  await b.close();
  console.log(f ? `✘ ${f} failed, ${n} passed` : `✔ all passed (${n} checks)`); process.exit(f ? 1 : 0);
})();
