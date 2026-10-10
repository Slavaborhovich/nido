// פנקס פיתוח: one list grouped by stage (idea → spec → plan → dev → test → prod), "next" button; "done" is a separate
// status (an item can be in production and still being checked), done items folded; old items mapped correctly. Local only, Firebase mocked.   node tests/devnotes.test.cjs
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
  ok(v.pipe.join() === "1,0,0,1,1,0,1", `summary: idea 1, dev 1, test 1, prod 0 open, done 1 (${v.pipe})`);
  ok(v.secs.join("|") === "🔧 בפיתוח 1|🧪 בטסט 1|💡 רעיונות 1", `work in progress first, then ideas (${v.secs.join(" | ")})`);
  ok(!v.rows.includes("ישן שבוצע") && /בוצע · 1/.test(v.fold), `old "done" item is done, folded at the bottom ("${v.fold}")`);
  await p.click("[data-fold]"); await p.waitForTimeout(200); v = await view();
  ok(v.rows.includes("ישן שבוצע") && await p.evaluate(() => !!document.querySelector(".dv-prod .dv-done")), "unfold → done items, marked ✓ בוצע");

  await p.click('[data-id="a"] [data-next]'); await p.waitForTimeout(300);
  let a = await p.evaluate(() => ({ ...__db.get("a"), toast: __t.at(-1) }));
  ok(a.stage === "spec" && a.done === false && a.toast === "עבר לאפיון", `"הבא" moves an old open item idea → spec (${a.stage}, "${a.toast}")`);
  await p.click('[data-id="d"] [data-next]'); await p.waitForTimeout(300);
  const d = await p.evaluate(() => ({ ...__db.get("d"), toast: __t.at(-1) }));
  ok(d.stage === "prod" && d.closed === false && d.doneAt > 0 && /^\d+\.\d+$/.test(d.doneVer), `test → production: date it went out (${d.doneVer}), but NOT done yet`);
  v = await view();
  ok(v.secs.some(x => x.includes("בפרודקשן · בבחינה")) && v.rows.includes("בטסט"), `it shows under "בפרודקשן · בבחינה" (${v.secs.join(" | ")})`);
  ok(await p.evaluate(() => !document.querySelector('[data-id="d"] [data-next]') && !!document.querySelector('[data-id="d"] [data-close-it]')), "in production the button is \"✓ בוצע\"");
  await p.click('[data-id="d"] [data-close-it]'); await p.waitForTimeout(300);
  const d2 = await p.evaluate(() => ({ ...__db.get("d"), pipe: [...document.querySelectorAll(".dv-pipe b")].map(x => +x.textContent).join() }));
  ok(d2.closed === true && d2.done === true && d2.stage === "prod" && d2.closedAt > 0 && d2.doneVer === d.doneVer, "✓ בוצע closes it, keeps the production date");
  ok(d2.pipe === "0,1,0,1,0,0,2", `…and it moves to the done count (${d2.pipe})`);

  await p.click('[data-id="c"] .t'); await p.waitForTimeout(700);
  ok(await p.evaluate(() => document.querySelector('#dvf input[name=stage][value=dev]')?.checked === true), "edit shows the item's stage");
  await p.evaluate(() => { document.querySelector('#dvf input[name=stage][value=plan]').checked = true; document.querySelector("#dvf").requestSubmit(); });
  await p.waitForTimeout(700);
  const c = await p.evaluate(() => __db.get("c"));
  ok(c.stage === "plan" && c.done === false && c.title === "בפיתוח עכשיו", `stage can be moved back by hand in edit (${c.stage})`);
  const back = await p.evaluate(() => { const x = DevNotes.withStage({ id: "z", closed: false, doneAt: 5, doneVer: "1.1", stage: "prod" }, "test"); return [x.closed, x.doneAt, x.doneVer].join(); });
  ok(back === "false,,", "taking an item back from production clears the production date");
  await p.click("[data-fold]").catch(() => {}); await p.waitForTimeout(200);
  if (!(await p.evaluate(() => !!document.querySelector('.dv-prod [data-id="b"]')))) { await p.click("[data-fold]"); await p.waitForTimeout(200); }
  await p.click('[data-id="b"] .t'); await p.waitForTimeout(700);
  ok(await p.evaluate(() => document.querySelector('#dvf input[name=status][value=done]')?.checked === true), "edit shows the status ✓ בוצע");
  await p.evaluate(() => { document.querySelector('#dvf input[name=status][value=open]').checked = true; document.querySelector("#dvf").requestSubmit(); });
  await p.waitForTimeout(700);
  const b2 = await p.evaluate(() => __db.get("b"));
  ok(b2.closed === false && b2.stage === "prod", `re-opened in edit → back in production, being checked (${b2.stage}, closed ${b2.closed})`);
  ok(errs.length === 0, `no page errors (${errs.join("; ") || "none"})`);
  await b.close(); console.log(`\n${f ? "✘ " + f + " FAILED" : "✔ all passed"} (${n} checks)`); process.exit(f ? 1 : 0);
})();
