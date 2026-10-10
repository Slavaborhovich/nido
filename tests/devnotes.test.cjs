// פנקס פיתוח: one list grouped by stage (idea → spec → plan → dev → test → prod), "next" button, production folded,
// old items (only done / not done) shown in the right place. Local only, Firebase mocked.   node tests/devnotes.test.cjs
const path = require("path");
let chromium;
try { ({ chromium } = require("playwright")); } catch (e) { ({ chromium } = require("/opt/npm-tools/node_modules/playwright")); }
const FILE = "file://" + path.join(__dirname, "..", "index.html") + "?cloud=1";
let f = 0, n = 0; const ok = (c, m) => { console.log((c ? "  ✔ " : "  ✘ FAIL ") + m); c ? n++ : f++; };

(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.route(/^https?:\/\//, r => r.abort());
  await p.goto(FILE); await p.waitForTimeout(400);
  await p.evaluate(() => {
    document.getElementById("splash")?.remove(); window.__t = []; toast = m => __t.push(m);
    const now = Date.now();
    window.__db = new Map(Object.entries({
      a: { title: "ישן פתוח", kind: "feature", prio: "mid", done: false, created: now - 5e6 },
      b: { title: "ישן שבוצע", kind: "bug", prio: "high", done: true, doneAt: now - 1e6, doneVer: "גרסה 9.10", created: now - 9e6 },
      c: { title: "בפיתוח עכשיו", kind: "improve", prio: "high", stage: "dev", done: false, created: now - 1e6 },
      d: { title: "בטסט", kind: "feature", prio: "low", stage: "test", done: false, created: now - 2e6 },
    }));
    let cb = null; const emit = () => cb && cb({ docs: [...__db].map(([id, x]) => ({ id, data: () => x })) });
    Cloud.isSuper = true; Cloud.user = { uid: BOOT_ADMIN_UID };
    Cloud.fb = { collection: (d, ...a) => a.join("/"), doc: (c, id) => id,
      onSnapshot: (c, ok) => { cb = ok; setTimeout(emit, 0); return () => {}; },
      setDoc: async (id, x) => { __db.set(id, x); setTimeout(emit, 0); }, deleteDoc: async id => { __db.delete(id); setTimeout(emit, 0); } };
    DevNotes.open();
  });
  await p.waitForTimeout(500);
  const view = () => p.evaluate(() => ({
    secs: [...document.querySelectorAll(".dv-sec")].map(x => x.textContent.replace(/\s+/g, " ").trim()),
    pipe: [...document.querySelectorAll(".dv-pipe b")].map(x => +x.textContent),
    rows: [...document.querySelectorAll("#dvList .dv-it b")].map(x => x.textContent),
    fold: document.querySelector("[data-fold]")?.textContent.replace(/\s+/g, " ").trim(), seg: !!document.querySelector(".dv-seg") }));
  let v = await view();
  ok(!v.seg, "no filter bar any more");
  ok(v.pipe.join() === "1,0,0,1,1,1", `summary per stage: idea 1, dev 1, test 1, prod 1 (${v.pipe})`);
  ok(v.secs.join("|") === "🔧 בפיתוח 1|🧪 בטסט 1|💡 רעיונות 1", `work in progress first, then ideas (${v.secs.join(" | ")})`);
  ok(!v.rows.includes("ישן שבוצע") && /בפרודקשן · 1/.test(v.fold), `old "done" item is in production, folded ("${v.fold}")`);
  await p.click("[data-fold]"); await p.waitForTimeout(200); v = await view();
  ok(v.rows.includes("ישן שבוצע") && await p.evaluate(() => document.querySelector(".dv-prod .dv-ver").textContent.includes("9.10")), "unfold → production items with the date they went out");

  await p.click('[data-id="a"] [data-next]'); await p.waitForTimeout(300);
  let a = await p.evaluate(() => ({ ...__db.get("a"), toast: __t.at(-1) }));
  ok(a.stage === "spec" && a.done === false && a.toast === "עבר לאפיון", `"הבא" moves an old open item idea → spec (${a.stage}, "${a.toast}")`);
  await p.click('[data-id="d"] [data-next]'); await p.waitForTimeout(300);
  const d = await p.evaluate(() => ({ ...__db.get("d"), toast: __t.at(-1) }));
  ok(d.stage === "prod" && d.done === true && d.doneAt > 0 && /^\d+\.\d+$/.test(d.doneVer) && d.toast === "✓ עלה לפרודקשן", `test → production marks it done with today's date (${d.doneVer})`);
  ok(await p.evaluate(() => !document.querySelector('[data-id="d"] [data-next]')), "production items have no 'next' button");

  await p.click('[data-id="c"] .t'); await p.waitForTimeout(700);
  ok(await p.evaluate(() => document.querySelector('#dvf input[name=stage][value=dev]')?.checked === true), "edit shows the item's stage");
  await p.evaluate(() => { document.querySelector('#dvf input[name=stage][value=plan]').checked = true; document.querySelector("#dvf").requestSubmit(); });
  await p.waitForTimeout(700);
  const c = await p.evaluate(() => __db.get("c"));
  ok(c.stage === "plan" && c.done === false && c.title === "בפיתוח עכשיו", `stage can be moved back by hand in edit (${c.stage})`);
  const back = await p.evaluate(() => { const x = DevNotes.withStage({ id: "z", done: true, doneAt: 5, doneVer: "1.1", stage: "prod" }, "test"); return [x.done, x.doneAt, x.doneVer].join(); });
  ok(back === "false,,", "taking an item back from production clears the done date");
  ok(errs.length === 0, `no page errors (${errs.join("; ") || "none"})`);
  await b.close(); console.log(`\n${f ? "✘ " + f + " FAILED" : "✔ all passed"} (${n} checks)`); process.exit(f ? 1 : 0);
})();
