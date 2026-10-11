// הוצאות: amounts in whole agorot; the month's totals kept with atomic increments (add / edit / move month / delete);
// only the open month is loaded; budget + categories saved; who sees the screen. Firebase mocked, no network.
//   node tests/expenses.test.cjs
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
  await p.evaluate(() => { document.getElementById("splash")?.remove(); window.__t = []; toast = m => __t.push(m); });

  ok(await p.evaluate(() => parseAmount("186.40") === 18640 && parseAmount("1,200") === 120000 && parseAmount("₪ 12") === 1200 && parseAmount("0") === null && parseAmount("1.234") === null && parseAmount("abc") === null),
     "amounts become whole agorot (186.40 → 18640); 0, 3 decimals and text are refused");
  ok(await p.evaluate(() => tabsNow().map(t => t[0]).join() === "today,tasks,shop,money,cal,ideas"), "the הוצאות tab sits between קניות and יומן");
  ok(await p.evaluate(() => { Money.settings = { cats: [{ id: "food", name: "סופר ומזון", emoji: "🛒" }, { id: "car", name: "רכב ודלק", emoji: "⛽" }, { id: "pets", name: "חיות מחמד", emoji: "🐶" }] };
    const cs = Money.cats(), ids = cs.map(c => c.id); Money.settings = null;
    return ["pets", "rent", "eatout", "fuel", "insurance"].every(x => ids.includes(x)) && ids.filter(x => x === "food").length === 1 && cs.find(c => c.id === "car").name === "רכב"; }),
    "new built-in categories (שכר דירה, אוכל בחוץ, דלק, ביטוחים) reach a family that already saved its list; \"רכב ודלק\" becomes \"רכב\"; no duplicates");

  // ---- the cloud path, with an in-memory Firestore ----
  await p.evaluate(() => {
    window.__db = new Map(); window.__reads = [];
    const isInc = v => v && v.__inc !== undefined;
    const merge = (t, src) => { for (const [k, v] of Object.entries(src)) { if (isInc(v)) t[k] = (t[k] || 0) + v.__inc; else if (v && typeof v === "object" && !Array.isArray(v)) { t[k] = t[k] || {}; merge(t[k], v); } else t[k] = v; } return t; };
    const listeners = []; const emit = () => listeners.forEach(fn => fn());
    const P = (...a) => a.join("/");
    Cloud.user = { uid: "U" }; Cloud.fam = "home"; Cloud.db = {};
    Cloud.fb = {
      collection: (db, ...a) => P(...a), doc: (db, ...a) => P(...a), where: (f, op, v) => ({ f, v }), query: (c, w) => ({ c, w }), increment: k => ({ __inc: k }),
      onSnapshot: (q, fn) => { const run = typeof q === "string"
          ? () => { const d = __db.get(q); fn({ exists: () => !!d, data: () => d && JSON.parse(JSON.stringify(d)) }); }
          : () => { __reads.push(q.w.v); fn({ docs: [...__db].filter(([k, x]) => k.startsWith(q.c + "/") && x[q.w.f] === q.w.v).map(([k, x]) => ({ id: k.split("/").pop(), data: () => JSON.parse(JSON.stringify(x)) })) }); };
        listeners.push(run); setTimeout(run, 0); return () => listeners.splice(listeners.indexOf(run), 1); },
      getDoc: async r => { const d = __db.get(r); return { exists: () => !!d, data: () => d }; },
      setDoc: async (r, x) => { __db.set(r, JSON.parse(JSON.stringify(x))); setTimeout(emit, 0); },
      writeBatch: () => { const ops = []; return { set(r, x, o) { ops.push(() => __db.set(r, o && o.merge ? merge(__db.get(r) || {}, x) : JSON.parse(JSON.stringify(x)))); },
        delete(r) { ops.push(() => __db.delete(r)); }, async commit() { ops.forEach(o => o()); setTimeout(emit, 0); } }; },
    };
  });
  const R = (js, a) => p.evaluate(js, a);
  const m = await R(() => iso(new Date()).slice(0, 7)), pm = await R(m => addMonth(m, -1), m);
  const base = "families/home/envs/" + (await R(() => ENV));
  // CLOUD is false in demo mode, so the cloud branch of Money.put / Money.del is replayed here exactly as written
  // (the two "checked against the code" assertions make sure this copy stays the same as the app's)
  const cloudPut = (e, old) => R(([e, old]) => { const F = Cloud.fb, b = F.writeBatch(Cloud.db); const { id, ...x } = e; b.set(Money.ref("expenses", id), x); if (old) b.set(Money.ref("expmonths", old.month), Money.inc(old, -1), { merge: true }); b.set(Money.ref("expmonths", e.month), Money.inc(e, 1), { merge: true }); return b.commit(); }, [e, old]);
  const putSrc = await R(() => Money.put.toString());
  ok(/b\.set\(this\.ref\("expmonths", old\.month\), this\.inc\(old, -1\)/.test(putSrc) && /b\.set\(this\.ref\("expmonths", e\.month\), this\.inc\(e, 1\)/.test(putSrc), "Money.put writes the expense + the month totals in ONE batch (checked against the code used below)");
  const e1 = { id: "x1", amount: 18640, desc: "סופר", cat: "food", payer: "slava", date: m + "-03", month: m };
  const e2 = { id: "x2", amount: 42000, desc: "הופעה", cat: "fun", payer: "tehila", date: m + "-04", month: m };
  await cloudPut(e1); await cloudPut(e2);
  let mo = await R(k => __db.get(k), base + "/expmonths/" + m);
  ok(mo.total === 60640 && mo.n === 2 && mo.cats.food === 18640 && mo.cats.fun === 42000 && mo.payers.slava === 18640 && mo.payers.tehila === 42000, `two expenses → month totals by category and payer (${JSON.stringify(mo)})`);
  await cloudPut({ ...e1, amount: 20000, date: pm + "-28", month: pm }, e1);
  mo = await R(k => __db.get(k), base + "/expmonths/" + m); const mp = await R(k => __db.get(k), base + "/expmonths/" + pm);
  ok(mo.total === 42000 && mo.n === 1 && mo.cats.food === 0 && mp.total === 20000 && mp.n === 1, "edited amount + moved to last month → removed from this month, added to last month");
  await R(([e]) => { const b = Cloud.fb.writeBatch(Cloud.db); b.delete(Money.ref("expenses", e.id)); b.set(Money.ref("expmonths", e.month), Money.inc(e, -1), { merge: true }); return b.commit(); }, [e2]);
  mo = await R(k => __db.get(k), base + "/expmonths/" + m);
  ok(mo.total === 0 && mo.n === 0 && !(await R(k => __db.has(k), base + "/expenses/x2")), "delete → expense gone and the month back to 0");
  const delSrc = await R(() => Money.del.toString());
  ok(/b\.delete\(this\.ref\("expenses", e\.id\)\); b\.set\(this\.ref\("expmonths", e\.month\), this\.inc\(e, -1\)/.test(delSrc), "Money.del does the same delete + decrement in one batch");

  // ---- demo mode end to end through the real screen ----
  await R(() => { localStorage.removeItem("nido.money"); Money.m = null; go("money"); });
  await p.waitForTimeout(400);
  await R(() => document.getElementById("fab").click()); await p.waitForTimeout(400);
  await p.fill('#xf input[name=amount]', "186.40"); await p.fill('#xf input[name=desc]', "קניות שבועיות");
  await R(() => document.querySelector('[data-cat="food"]').click());
  await p.click("#xf [type=submit]"); await p.waitForTimeout(500);
  let st = await R(() => ({ big: document.querySelector(".mn-big")?.textContent, t: __t.at(-1), st: JSON.parse(localStorage.getItem("nido.money")).ex[0] }));
  ok(st.st.amount === 18640 && st.st.month === m && st.st.by === "slava" && st.big === "₪186" && /186\.4/.test(st.t), `added through the screen: stored 18640 agorot, the screen shows ${st.big}`);
  await R(() => document.querySelector("[data-budget]").click()); await p.waitForTimeout(400);
  await p.fill('#bf input[name=total]', "12000"); await p.fill('[data-bc="food"]', "3500");
  await p.fill("#ncName", "חיות מחמד"); await p.fill("#ncEmoji", "🐶"); await p.click("#ncAdd");
  await p.click("#bf [type=submit]"); await p.waitForTimeout(500);
  st = await R(() => ({ s: JSON.parse(localStorage.getItem("nido.money")).settings, ring: document.querySelector(".mn-ring b").textContent }));
  ok(st.s.budget.total === 1200000 && st.s.budget.cats.food === 350000 && st.s.cats.some(c => c.name === "חיות מחמד" && c.emoji === "🐶") && st.ring === "2%", `budget ₪12,000 (+ ₪3,500 for food) and a new category saved; ring shows ${st.ring}`);
  await R(() => { S.moneyView = "hist"; renderMoney(); }); await p.waitForTimeout(200);
  ok(await R(() => document.querySelectorAll(".mn-ex").length === 1 && document.querySelectorAll(".mn-cmp .b").length === 6), "history: the expense listed, 6 months compared");
  await R(() => { askConfirm = async () => true; document.querySelector(".mn-ex").click(); }); await p.waitForTimeout(400);
  await p.click("#xDel"); await p.waitForTimeout(400);
  ok(await R(() => JSON.parse(localStorage.getItem("nido.money")).ex.length === 0), "delete from the edit window (after confirming)");

  // ---- installments & recurring ----
  ok(await R(() => { const it = planItems({ id:"P", kind:"inst", amount:100000, n:3, start:"2026-01-31", desc:"", cat:"home", payer:"slava" });
      return it.map(x => x.amount).join() === "33334,33333,33333" && it.map(x => x.date).join() === "2026-01-31,2026-02-28,2026-03-31" && it[2].plan.k === 3 && it[2].plan.n === 3 && it[1].id === "P_2"; }),
     "installments: ₪1,000 in 3 → 333.34 + 333.33 + 333.33 (whole agorot, sums exactly); the 31st becomes Feb 28");
  ok(await R(() => { const it = planItems({ id:"R", kind:"rec", amount:390000, start:"2026-10-10", end:"2027-02" });
      return it.length === 5 && it.every(x => x.amount === 390000) && it[4].month === "2027-02" && it[4].date === "2027-02-10"; }),
     "rent ₪3,900 from 10/2026 to end of February 2027 → exactly 5 months, then it stops");
  const today = await R(() => iso(new Date())), dim = await R(m => new Date(+m.slice(0, 4), +m.slice(5, 7), 0).getDate(), m);
  const futureDay = +today.slice(8, 10) < dim ? m + "-" + String(dim).padStart(2, "0") : null;
  await R(() => { localStorage.removeItem("nido.money"); Money.m = null; S.moneyView = "over"; renderMoney(); });
  // installments through the screen: ₪3,000 in 10, first one today
  await R(() => document.getElementById("fab").click()); await p.waitForTimeout(400);
  await R(() => document.querySelector('[data-k="inst"]').click());
  await p.fill('#xf input[name=amount]', "3000"); await p.fill('#xf input[name=desc]', "מקרר"); await p.fill('#xf input[name=n]', "10");
  const pv = await R(() => document.querySelector("#xPrev").textContent);
  await p.click("#xf [type=submit]"); await p.waitForTimeout(500);
  st = await R(() => { const d = JSON.parse(localStorage.getItem("nido.money")); return { n: d.ex.length, sum: d.ex.reduce((a, e) => a + e.amount, 0), months: new Set(d.ex.map(e => e.month)).size, plans: d.plans.length,
    big: document.querySelector(".mn-big")?.textContent, row: document.querySelector(".mn-plan small")?.textContent }; });
  ok(/10 תשלומים של ₪300/.test(pv) && st.n === 10 && st.sum === 300000 && st.months === 10 && st.plans === 1, `₪3,000 in 10 payments → 10 monthly expenses of ₪300, one per month (preview: "${pv}")`);
  ok(st.big === "₪300" && /תשלום 1 מתוך 10/.test(st.row) && /2,700/.test(st.row), `only this month's payment counts now (${st.big}); the list shows "${st.row}"`);
  // recurring rent with an end month
  await R(() => document.getElementById("fab").click()); await p.waitForTimeout(400);
  await R(() => document.querySelector('[data-k="rec"]').click());
  const defEnd = await R(() => document.querySelector("#xf input[name=end]").value);
  await p.fill('#xf input[name=amount]', "3900"); await p.fill('#xf input[name=desc]', "שכר דירה");
  await R(() => document.querySelector('[data-cat="rent"]').click());
  if (futureDay) await p.fill('#xf input[name=date]', futureDay);
  const endM = await R(m => addMonth(m, 4), m);
  await p.fill('#xf input[name=end]', endM);
  await p.click("#xf [type=submit]"); await p.waitForTimeout(500);
  st = await R(() => { const d = JSON.parse(localStorage.getItem("nido.money")); const r = d.ex.filter(e => e.cat === "rent");
    return { n: r.length, last: r.map(e => e.month).sort().at(-1), big: document.querySelector(".mn-big")?.textContent, soon: [...document.querySelectorAll(".mn-soon")].map(x => x.textContent), plans: document.querySelectorAll(".mn-plan").length }; });
  ok(defEnd === await R(m => addMonth(m, 11), m) && st.n === 5 && st.last === endM && st.plans === 2, `rent ₪3,900 until ${endM} → 5 months written, last one ${st.last} (default end was a year: ${defEnd})`);
  if (futureDay) ok(st.big === "₪300" && st.soon.length === 1 && /שכר דירה/.test(st.soon[0]) && /3,900/.test(st.soon[0]), `rent due on the ${dim}th shows under "צפוי החודש" and isn't counted yet (spent ${st.big})`);
  else ok(st.big === "₪4,200", "last day of the month: rent already counted");
  // extend the rent by 2 months, then shorten it to this month
  const rentPlan = await R(() => Money.plans.find(x => x.kind === "rec").id);
  await R(id => planSheet(Money.plans.find(x => x.id === id)), rentPlan); await p.waitForTimeout(400);
  await p.fill("#pEnd", await R(m => addMonth(m, 6), m)); await p.click("#pSave"); await p.waitForTimeout(400);
  const n7 = await R(() => JSON.parse(localStorage.getItem("nido.money")).ex.filter(e => e.cat === "rent").length);
  await R(id => planSheet(Money.plans.find(x => x.id === id)), rentPlan); await p.waitForTimeout(400);
  await p.fill("#pEnd", m); await p.click("#pSave"); await p.waitForTimeout(400);
  const n1 = await R(() => JSON.parse(localStorage.getItem("nido.money")).ex.filter(e => e.cat === "rent").length);
  ok(n7 === 7 && n1 === 1, `contract end moved later → 7 months (${n7}); moved to this month → 1 (${n1})`);
  // delete one installment → "only this month" vs "this and the rest"
  await R(() => { askChoice = async () => "rest"; const e = Money.list.find(x => x.plan && x.plan.kind === "inst"); expenseSheet(e); }); await p.waitForTimeout(400);
  const lbl = await R(() => document.querySelector("#xPlan")?.textContent || "");
  await p.click("#xDel"); await p.waitForTimeout(400);
  st = await R(() => { const d = JSON.parse(localStorage.getItem("nido.money")); return { inst: d.ex.filter(e => e.plan && e.plan.kind === "inst").length, plans: d.plans.filter(x => x.kind === "inst").length }; });
  ok(/תשלום 1 מתוך 10/.test(lbl) && st.inst === 0 && st.plans === 0, `editing a payment says "${lbl.trim().split(" ·")[0]}"; delete "this and the rest" from payment 1 removes the whole plan`);
  // stop from the plan window: keeps what was paid, removes what hasn't come
  await R(() => Money.addPlan({ id:"S", kind:"inst", amount:120000, n:6, start: addMonth(iso(new Date()).slice(0, 7), -2) + "-01", desc:"ספה", cat:"home", payer:"slava", by:"slava", at:1 }));
  await R(() => { askChoice = async () => "rest"; planSheet(Money.plans.find(x => x.id === "S")); }); await p.waitForTimeout(400);
  await p.click("#pStop"); await p.waitForTimeout(400);
  st = await R(() => { const d = JSON.parse(localStorage.getItem("nido.money")); return { left: d.ex.filter(e => e.id.startsWith("S_")).map(e => e.id).sort().join(), stop: d.plans.find(x => x.id === "S").stop }; });
  ok(st.left === "S_1,S_2,S_3" && st.stop === 3, `stopping a 6-payment plan in month 3 keeps the 3 already due (${st.left}) and removes the rest`);

  // the same plan paths against the (mocked) cloud: the month totals stay exact
  await R(() => { for (const k of [...__db.keys()]) __db.delete(k); });
  st = await R(async () => {
    const as = n => new Function("CLOUD", "return async function " + Money[n].toString().replace(/^async\s+/, ""))(true).bind(Money);
    const keep = { addPlan: Money.addPlan, cutPlan: Money.cutPlan, savePlans: Money.savePlans };
    const add = as("addPlan"), cut = as("cutPlan"), end = as("setPlanEnd"); Money.addPlan = add; Money.cutPlan = cut; Money.savePlans = as("savePlans");
    Money.plans = []; const m0 = iso(new Date()).slice(0, 7), base = "families/home/envs/" + ENV;
    await add({ id:"C", kind:"inst", amount:100000, n:3, start: m0 + "-05", desc:"", cat:"home", payer:"slava", by:"slava", at:1 });
    const t = k => (__db.get(base + "/expmonths/" + addMonth(m0, k)) || {}).total;
    const a = [t(0), t(1), t(2)].join(), plansDoc = __db.get(base + "/expmeta/plans").list.length;
    await cut(Money.plans[0], 2);
    const b = [t(0), t(1) || 0, t(2) || 0].join(), docs = [...__db.keys()].filter(k => k.includes("/expenses/C_")).length;
    await add({ id:"D", kind:"rec", amount:390000, start: m0 + "-10", end: addMonth(m0, 1), desc:"", cat:"rent", payer:"slava", by:"slava", at:1 });
    await end(Money.plans.find(x => x.id === "D"), addMonth(m0, 3)); const c = [t(2), t(3)].join();
    await end(Money.plans.find(x => x.id === "D"), m0); const d = [t(1), t(2), t(3)].join();
    Object.assign(Money, keep);
    return { a, plansDoc, b, docs, c, d };
  });
  ok(st.a === "33334,33333,33333" && st.plansDoc === 1, `cloud: a 3-payment plan adds each payment to its own month's total (${st.a})`);
  ok(st.b === "33334,0,0" && st.docs === 1, `cloud: cutting from payment 2 takes those amounts back off the month totals (${st.b})`);
  ok(st.c === "390000,390000" && st.d === "0,0,0", `cloud: rent extended → new months counted (${st.c}); shortened → removed again (${st.d})`);

  // ---- who sees it ----
  ok(await R(() => moneyOn() && USERS[me].role === "admin"), "the family admin sees הוצאות");
  ok(await R(() => { const r = USERS[me].role; const out = ["editor", "viewer"].map(x => { USERS[me].role = x; return !moneyOn() && !tabsNow().some(t => t[0] === "money"); }); USERS[me].role = r; return out.every(Boolean); }), "an editor and a view-only member (e.g. a child) have no הוצאות tab");
  ok(errs.length === 0, `no page errors (${errs.join("; ") || "none"})`);
  await b.close(); console.log(`\n${f ? "✘ " + f + " FAILED" : "✔ all passed"} (${n} checks)`); process.exit(f ? 1 : 0);
})();
