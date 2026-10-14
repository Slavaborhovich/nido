// הוצאות → סקירה: tapping a category opens its expenses (one category at a time, up to 5 then "עוד"),
// a row opens the edit window; built-in categories show 3D Fluent pictures, the family's own keep their emoji.
//   node tests/exp-cats-open.test.cjs
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

  await R(() => {
    const t = iso(new Date()), m = t.slice(0, 7), d = k => m + "-" + String(k).padStart(2, "0");
    const day = Math.max(1, Math.min(+t.slice(8, 10), 28));
    const ex = [];
    for (let i = 0; i < 7; i++) ex.push({ id: "f" + i, amount: (i + 1) * 1000, desc: "סופר " + i, cat: "food", payer: "slava", date: d(Math.max(1, day - i % day)), month: m, by: "slava", at: i });
    ex.push({ id: "g1", amount: 30000, desc: "תדלוק", cat: "fuel", payer: "slava", date: d(day), month: m, by: "slava", at: 9 });
    ex.push({ id: "p1", amount: 5000, desc: "אוכל לכלב", cat: "pets", payer: "slava", date: d(day), month: m, by: "slava", at: 10 });
    localStorage.setItem("nido.money", JSON.stringify({ ex, plans: [], settings: { cats: [...EXP_CATS0.map(([id, name, emoji]) => ({ id, name, emoji })), { id: "pets", name: "חיות", emoji: "🐶" }],
      budget: { total: 1000000, cats: { food: 300000, fuel: 70000 } } } }));
    Money.m = null; S.moneyView = "over"; S.mnOpen = null; go("money");
  });
  await p.waitForTimeout(500);

  let st = await R(() => ({ cgs: document.querySelectorAll(".mn-cg").length, open: document.querySelectorAll(".mn-cg.open").length,
    food: document.querySelector('[data-cg="food"] .mn-e img')?.getAttribute("src"), fuel: document.querySelector('[data-cg="fuel"] .mn-e img')?.getAttribute("src"),
    pets: document.querySelector('[data-cg="pets"] .mn-e')?.textContent, cnt: document.querySelector('[data-cg="food"] .cnt')?.textContent }));
  ok(st.cgs === 3 && st.open === 0, `3 categories listed, all closed (${st.cgs})`);
  ok(st.food === "icons/fluent/cart.png" && st.fuel === "icons/fluent/fuel.png" && st.pets === "🐶", "built-in categories show 3D pictures; the family's own category keeps its emoji");
  ok(/7/.test(st.cnt || ""), `the category shows how many expenses it has (${st.cnt})`);

  await R(() => document.querySelector('[data-cg="food"] .mn-cat').click()); await p.waitForTimeout(400);
  st = await R(() => { const g = document.querySelector('[data-cg="food"]'); return { open: g.classList.contains("open"), exp: g.querySelector(".mn-cat").getAttribute("aria-expanded"),
    vis: [...g.querySelectorAll(".mn-it")].filter(x => !x.hidden).length, all: g.querySelectorAll(".mn-it").length, more: g.querySelector(".mn-more")?.textContent, h: g.querySelector(".mn-drop").offsetHeight, foot: g.querySelector(".mn-cfoot").textContent }; });
  ok(st.open && st.exp === "true" && st.h > 100, `tap → the category opens (${st.h}px)`);
  ok(st.vis === 5 && st.all === 7 && /עוד 2/.test(st.more), `5 expenses shown, "${st.more}" for the rest`);
  ok(/7 הוצאות/.test(st.foot) && /נשארו/.test(st.foot), `footer: "${st.foot}"`);
  await R(() => document.querySelector('[data-cg="food"] .mn-more').click());
  ok(await R(() => [...document.querySelectorAll('[data-cg="food"] .mn-it')].every(x => !x.hidden) && !document.querySelector('[data-cg="food"] .mn-more')), "עוד → all 7 shown");

  await R(() => document.querySelector('[data-cg="fuel"] .mn-cat').click()); await p.waitForTimeout(400);
  st = await R(() => [...document.querySelectorAll(".mn-cg.open")].map(g => g.dataset.cg));
  ok(st.join() === "fuel", `opening another category closes the first (${st})`);
  await R(() => renderMoney()); await p.waitForTimeout(100);
  ok(await R(() => document.querySelector('[data-cg="fuel"]').classList.contains("open")), "stays open when the screen refreshes");
  await R(() => document.querySelector('[data-cg="fuel"] .mn-cat').click()); await p.waitForTimeout(400);
  ok(await R(() => !document.querySelector(".mn-cg.open")), "tap again → closes");

  await R(() => document.querySelector('[data-cg="fuel"] .mn-cat').click()); await p.waitForTimeout(400);
  await R(() => document.querySelector('[data-cg="fuel"] .mn-it').click()); await p.waitForTimeout(400);
  ok(await R(() => document.querySelector('#xf input[name=desc]')?.value === "תדלוק"), "tapping an expense opens it for editing");
  ok(await R(() => !!document.querySelector('#xf [data-cat="fuel"] img.mn-fl')), "the category chips in the edit window show the 3D pictures too");

  ok(!errs.length, "no page errors" + (errs.length ? ": " + errs.join(" | ") : ""));
  await b.close();
  console.log(f ? `✘ ${f} failed, ${n} passed` : `✔ all passed (${n} checks)`); process.exit(f ? 1 : 0);
})();
