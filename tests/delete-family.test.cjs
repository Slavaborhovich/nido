// Admin → family → "מחיקת …": a real click, two confirmations, then every record of the family is deleted.
// Local only: the real index.html in headless Chromium, Firebase replaced by an in-memory mock, all network blocked.
//   node tests/delete-family.test.cjs
const path = require("path");
let chromium;
try { ({ chromium } = require("playwright")); } catch (e) { ({ chromium } = require("/opt/npm-tools/node_modules/playwright")); }
const FILE = "file://" + path.join(__dirname, "..", "index.html") + "?cloud=1";
let f = 0, n = 0; const ok = (c, m) => { console.log((c ? "  ✔ " : "  ✘ FAIL ") + m); c ? n++ : f++; };

(async () => {
  const b = await chromium.launch();
  async function open(failCommit) {
    const p = await b.newPage(); const errs = []; p.on("pageerror", e => errs.push(e.message));
    await p.route(/^https?:\/\//, r => r.abort());
    await p.goto(FILE); await p.waitForTimeout(400);
    await p.evaluate(failCommit => {
      document.getElementById("splash")?.remove();
      window.__toasts = []; toast = m => window.__toasts.push(m);
      askConfirm = async () => { await new Promise(r => setTimeout(r, 20)); return true; };   // like the real dialog: resolves later
      window.__db = new Set(["families/fB", "families/fB/envs/prod/tasks/t1", "families/fB/envs/test/shop/s1", "families/fB/notes/n1",
        "families/fB/meta/m1", "users/u1", "logins/bob", "stats/fB", "families/home", "users/" + BOOT_ADMIN_UID]);
      Cloud.isSuper = true; Cloud.user = { uid: BOOT_ADMIN_UID };
      const P = (db, ...p) => p.join("/");
      Cloud.fb = { doc: P, collection: P,
        getDocs: async c => ({ docs: [...__db].filter(k => k.startsWith(c + "/") && k.split("/").length === c.split("/").length + 1).map(ref => ({ ref })) }),
        writeBatch: () => { const o = []; return { delete(r) { o.push(r); }, async commit() { if (failCommit) throw { code: "permission-denied" }; o.forEach(r => __db.delete(r)); } }; },
        deleteDoc: async r => { __db.delete(r); } };
      Object.keys(FAMILIES).forEach(k => delete FAMILIES[k]);
      Object.assign(FAMILIES, { home: { name: "בורחוביץ'" }, fB: { name: "בדיקות" } });
      Object.keys(ALLUSERS).forEach(k => delete ALLUSERS[k]);
      Object.assign(ALLUSERS, { slava: { uid: BOOT_ADMIN_UID, family: "home", name: "סלבה", role: "admin", active: true },
                                bob: { uid: "u1", family: "fB", name: "בוב", role: "admin", active: true } });
      $("#admin").hidden = false; document.body.classList.add("admin-open"); S.adminTab = "fams"; S.adminFam = "fB"; Admin.render();
    }, failCommit);
    return { p, errs };
  }

  console.log("\nAdmin — delete a family");
  let { p, errs } = await open(false);
  await p.click("[data-delfam]"); await p.waitForTimeout(500);
  const s = await p.evaluate(() => ({ db: [...__db].sort(), t: __toasts.at(-1), sel: S.adminFam }));
  ok(s.db.length === 2 && s.db[0] === "families/home" && s.db[1].startsWith("users/") && s.db[1] !== "users/u1",
     `everything of the family is gone, the main family and the admin stay (${s.db.join(", ")})`);
  ok(/^המשפחה נמחקה \(\d+ רשומות\)$/.test(s.t || "") && s.sel === null, `success message shown ("${s.t}")`);
  ok(errs.length === 0, `no page errors (${errs.join("; ") || "none"})`);
  await p.close();

  ({ p, errs } = await open(true));
  await p.click("[data-delfam]"); await p.waitForTimeout(500);
  const e = await p.evaluate(() => ({ t: __toasts.at(-1), has: __db.has("families/fB") }));
  const btn = await p.evaluate(() => { const x = document.querySelector("[data-delfam]"); return { dis: x.disabled, txt: x.textContent.trim() }; });
  ok(e.has && e.t && !e.t.includes("נמחקה"), `database refuses → nothing claimed, an error is shown ("${e.t}")`);
  ok(!btn.dis && btn.txt.includes("מחיקת"), `…and the button is usable again ("${btn.txt}")`);
  ok(errs.length === 0, `no page errors (${errs.join("; ") || "none"})`);
  await p.close();

  await b.close(); console.log(`\n${f ? "✘ " + f + " FAILED" : "✔ all passed"} (${n} checks)`); process.exit(f ? 1 : 0);
})();
