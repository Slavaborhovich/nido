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

  // ---- who sees it ----
  ok(await R(() => { const r = USERS[me].role; USERS[me].role = "viewer"; const off = !moneyOn() && !tabsNow().some(t => t[0] === "money"); USERS[me].role = r; return off; }), "a view-only member (e.g. a child) has no הוצאות tab");
  ok(errs.length === 0, `no page errors (${errs.join("; ") || "none"})`);
  await b.close(); console.log(`\n${f ? "✘ " + f + " FAILED" : "✔ all passed"} (${n} checks)`); process.exit(f ? 1 : 0);
})();
