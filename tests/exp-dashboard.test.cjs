// הוצאות → סקירה dashboard: status, ring toggle, the three numbers and their math, needs-attention (tap → category),
// time vs money / cumulative (with last month) / by day (tap a day → its expenses), "what if", category filters,
// add-in-category, who paid filter, folding sections (remembered), no-budget and past-month variants.
//   node tests/exp-dashboard.test.cjs
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
  await R(() => { document.getElementById("splash")?.remove(); window.__t = []; toast = m => __t.push(m); });

  const seed = (budget) => R(budget => {
    const t = iso(new Date()), m = t.slice(0, 7), pm = addMonth(m, -1), day = +t.slice(8, 10), d = (mm, k) => mm + "-" + String(Math.max(1, Math.min(k, day))).padStart(2, "0");
    const ex = []; let i = 0; const add = (mm, desc, a, cat, k, payer) => ex.push({ id: "e" + (i++), amount: a * 100, desc, cat, payer, date: mm === m ? d(mm, k) : mm + "-" + String(k).padStart(2, "0"), month: mm, by: "slava", at: i });
    add(m, "חשמל", 2000, "bills", 1, "slava"); add(m, "סופר", 300, "food", 1, "tehila"); add(m, "קפה", 50, "eatout", day, "tehila"); add(m, "נעליים", 400, "clothes", day, "tehila");
    add(pm, "סופר", 2500, "food", 5, "slava"); add(pm, "חשמל", 900, "bills", 9, "slava");
    localStorage.setItem("nido.money", JSON.stringify({ ex, plans: [], settings: budget ? { budget: { total: budget * 100, cats: { bills: 150000, food: 300000 } } } : null }));
    localStorage.removeItem("nido.mnClosed");
    Object.assign(S, { mnChart: null, mnSim: null, mnSimM: null, mnKpi: null, mnRing: false, mnOpen: null, mnFilter: "all", mnPayer: null, mnSel: null, mnLast: true });
    Money.m = null; Money.month = null; Money.prev = {}; S.moneyView = "over"; go("money");
  }, budget);

  await seed(10000); await p.waitForTimeout(500);
  let st = await R(() => ({ st: document.querySelector(".mn-st b")?.textContent, kpis: document.querySelectorAll(".mn-kpi").length, ring: document.querySelector(".mn-ring b").textContent,
    att: [...document.querySelectorAll(".mn-att [data-go]")].map(x => x.dataset.go), tm: !!document.querySelector(".mn-tm .verdict"), sim: !!document.querySelector("#mnSimR") }));
  ok(!!st.st && st.kpis === 3 && /%$/.test(st.ring), `status "${st.st}", three numbers, ring in %`);
  ok(st.att.includes("cat:bills"), "חשבונות over its budget shows under 'דורש תשומת לב'");
  ok(st.tm, "'זמן מול כסף' is the first view of how the month moves");
  const lastDay = await R(() => { const t = iso(new Date()); return +t.slice(8, 10) === new Date(+t.slice(0, 4), +t.slice(5, 7), 0).getDate(); });
  ok(lastDay ? !st.sim : st.sim, "'מה אם?' is there (except on the last day of the month)");

  await R(() => document.querySelector("[data-ring]").click()); await p.waitForTimeout(150);
  ok(await R(() => /נשאר|חריגה/.test(document.querySelector(".mn-ring small").textContent)), "tap the ring → ₪ left");
  await R(() => document.querySelector('[data-k="fc"]').click()); await p.waitForTimeout(150);
  ok(await R(() => document.querySelector(".mn-why.open") && /צפי לסוף החודש|סך הכול/.test(document.querySelector(".mn-why").textContent)), "tap the forecast → its math opens");

  await R(() => document.querySelector('[data-go="cat:bills"]').click()); await p.waitForTimeout(300);
  ok(await R(() => document.querySelector('.mn-cg[data-cg="bills"]').classList.contains("open")), "tap the alert → the category opens");

  await R(() => document.querySelector('[data-cm="cum"]').click()); await p.waitForTimeout(500);
  st = await R(() => ({ cur: !!document.querySelector("#mnChart .cur"), last: !!document.querySelector("#mnChart .last"), noswipe: document.querySelector("#mnChart").hasAttribute("data-noswipe") }));
  ok(st.cur && st.last && st.noswipe, "cumulative: this month + last month's line; dragging the chart doesn't swipe screens");
  await R(() => document.querySelector('[data-cm="day"]').click()); await p.waitForTimeout(300);
  ok(await R(() => document.querySelectorAll("#mnChart rect.b").length >= 1), "by day: a bar per day with expenses");
  // tap the first day
  await R(() => document.querySelector("#mnChart").scrollIntoView({ block: "center" })); await p.waitForTimeout(200);
  const box2 = await (await p.$("#mnChart")).boundingBox();
  const x1 = await R(() => mnChartSvg.o.X(1));
  await p.mouse.click(box2.x + x1 * box2.width / 380, box2.y + box2.height / 2); await p.waitForTimeout(300);
  ok(await R(() => document.querySelector("#mnDayl.open") && document.querySelectorAll("#mnDayl [data-ex]").length >= 1), "tap day 1 → its expenses are listed");

  if (!lastDay){
    await R(() => { const r = document.querySelector("#mnSimR"); r.value = 0; r.dispatchEvent(new Event("input")); });
    const a = await R(() => document.querySelector("#mnSimRes").textContent);
    await R(() => { const r = document.querySelector("#mnSimR"); r.value = r.max; r.dispatchEvent(new Event("input")); r.dispatchEvent(new Event("change")); }); await p.waitForTimeout(200);
    const b2 = await R(() => document.querySelector("#mnSimRes").textContent);
    ok(a !== b2 && /נסיים את החודש/.test(b2), `what if: the end of month follows the slider ("${a}" → "${b2}")`);
  }

  await R(() => document.querySelector('[data-f="free"]').click()); await p.waitForTimeout(150);
  st = await R(() => [...document.querySelectorAll(".mn-cg")].filter(x => !x.hidden).map(x => x.dataset.cg).sort().join());
  ok(st === "clothes,eatout", `filter 'בלי תקציב' → only categories without a budget (${st})`);
  await R(() => document.querySelector('[data-f="all"]').click()); await p.waitForTimeout(150);
  await R(() => { S.mnOpen = "food"; renderMoney(); document.querySelector('[data-addc="food"]').click(); }); await p.waitForTimeout(400);
  ok(await R(() => document.querySelector('#xf [data-cat].on')?.dataset.cat === "food"), "'＋ הוצאה ב…' opens the add window with that category");
  await R(() => closeSheet()); await p.waitForTimeout(300);

  await R(() => document.querySelector('[data-payer="tehila"]').click()); await p.waitForTimeout(150);
  ok(await R(() => document.querySelectorAll(".mn-who .lst [data-ex]").length === 3), "tap a name → only their expenses");

  await R(() => document.querySelector('[data-sx="prog"] .mn-sh').click()); await p.waitForTimeout(100);
  ok(await R(() => JSON.parse(localStorage.getItem("nido.mnClosed")).prog === 1), "folding a section is remembered");
  await R(() => renderMoney());
  ok(await R(() => document.querySelector('[data-sx="prog"]').classList.contains("closed")), "…and stays folded after a refresh");

  await seed(0); await p.waitForTimeout(500);
  st = await R(() => ({ st: !!document.querySelector(".mn-st"), tm: !!document.querySelector('[data-cm="tm"]'), sim: !!document.querySelector("#mnSimR"), cur: !!document.querySelector("#mnChart .cur"), setb: !!document.querySelector(".mn-setb") }));
  ok(!st.st && !st.tm && !st.sim && st.cur && st.setb, "no budget: no status / time vs money / what-if; cumulative chart and 'קביעת תקציב'");

  await seed(10000); await R(() => { Money.month = addMonth(Money.m, -1); renderMoney(); }); await p.waitForTimeout(400);
  st = await R(() => ({ sim: !!document.querySelector("#mnSimR"), daily: !!document.querySelector(".mn-daily"), tm: document.querySelector(".mn-tm .verdict")?.textContent }));
  ok(!st.sim && !st.daily && /החודש נגמר/.test(st.tm || ""), `past month: no what-if or daily budget; "${st.tm}"`);

  ok(!errs.length, "no page errors" + (errs.length ? ": " + errs.join(" | ") : ""));
  await b.close();
  console.log(f ? `✘ ${f} failed, ${n} passed` : `✔ all passed (${n} checks)`); process.exit(f ? 1 : 0);
})();
