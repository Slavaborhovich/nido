// System admin resets a forgotten password: new sign-in account, profile moved to it, login name points to it,
// old profile removed. Only the system admin sees the button. Firebase mocked, no network.   node tests/pw-reset.test.cjs
const path = require("path");
let chromium;
try { ({ chromium } = require("playwright")); } catch (e) { ({ chromium } = require("/opt/npm-tools/node_modules/playwright")); }
const FILE = "file://" + path.join(__dirname, "..", "index.html") + "?cloud=1";
let f = 0, n = 0; const ok = (c, m) => { console.log((c ? "  ✔ " : "  ✘ FAIL ") + m); c ? n++ : f++; };
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.route(/^https?:\/\//, r => r.abort());
  await p.goto(FILE); await p.waitForTimeout(500);
  const setup = super_ => p.evaluate(sup => { document.getElementById("splash")?.remove(); localStorage.clear(); closeSheet && closeSheet();
    const T = { name: "תהילה", role: "editor", color: "#C3B1FF", active: true, uid: "t1", family: "home" };
    const S = { name: "סלבה", role: "admin", color: "#7FB0FF", active: true, uid: BOOT_ADMIN_UID, family: "home" };
    USERS.tehila = T; USERS.slava = S; ALLUSERS.tehila = T; ALLUSERS.slava = S;
    me = sup ? "slava" : "tehila"; Cloud.user = { uid: sup ? BOOT_ADMIN_UID : "t1" }; Cloud.isSuper = sup;
    $("#login").hidden = true; $("#app").hidden = false;
    window.LOG = [];
    const doc = (db, ...pth) => ({ path: pth.join("/") });
    Cloud.db = {}; Cloud.A = { initializeApp: () => ({}) }; Cloud.secApp = null;
    Cloud.fb = { doc, getAuth: () => ({}), setPersistence: async () => {}, inMemoryPersistence: {}, signOut: async () => LOG.push(["signOut"]),
      getDoc: async d => ({ exists: () => d.path === "users/t1", data: () => ({ username: "tehila", name: "תהילה", role: "editor", family: "home", notif: { a: 1 }, active: true }) }),
      createUserWithEmailAndPassword: async (a, email, pw) => { LOG.push(["create", email, pw]); return { user: { uid: "t2" } }; },
      writeBatch: () => { const ops = []; return { set: (d, v) => ops.push(["set", d.path, v]), delete: d => ops.push(["del", d.path]), commit: async () => LOG.push(["commit", ops]) }; } };
  }, super_);

  await setup(false);
  await p.evaluate(() => openUserEdit("slava")); await p.waitForTimeout(300);
  ok(!(await p.$("#uePw")), "family member: no reset button");

  await setup(true);
  await p.evaluate(() => openUserEdit("slava")); await p.waitForTimeout(300);
  ok(!(await p.$("#uePw")), "system admin on himself: no reset button");
  await p.evaluate(() => openUserEdit("tehila")); await p.waitForTimeout(300);
  ok(!!(await p.$("#uePw")), "system admin on another user: reset button shown");
  await p.click("#uePw"); await p.waitForTimeout(300);
  await p.fill("#pwr input[name=pw]", "123"); await p.click("#pwrSave"); await p.waitForTimeout(200);
  ok((await p.textContent("#pwrErr")).includes("קצרה"), "short password is refused");
  ok(await p.evaluate(() => LOG.length === 0), "nothing changed for a short password");
  await p.fill("#pwr input[name=pw]", "newpass77"); await p.click("#pwrSave"); await p.waitForTimeout(400);
  const conf = await p.$$(".confirm button, [data-ok], .ask .primary");
  await p.evaluate(() => { const bs = [...document.querySelectorAll("button")].filter(x => x.textContent.trim() === "איפוס" && !x.closest("#pwr")); bs[bs.length - 1]?.click(); });
  await p.waitForTimeout(600);
  const log = await p.evaluate(() => LOG);
  const cr = log.find(x => x[0] === "create"), cm = log.find(x => x[0] === "commit");
  ok(cr && /^tehila\.[a-z0-9]+@nido\.family$/.test(cr[1]) && cr[2] === "newpass77", "new account made with the new password and a fresh e-mail");
  ok(cm && cm[1].some(o => o[0] === "set" && o[1] === "users/t2" && o[2].username === "tehila" && o[2].role === "editor" && o[2].notif.a === 1 && o[2].pwResetAt > 0), "profile copied to the new account (all fields kept)");
  ok(cm && cm[1].some(o => o[0] === "set" && o[1] === "logins/tehila" && o[2].uid === "t2" && o[2].email === cr[1]), "login name points to the new account");
  ok(cm && cm[1].some(o => o[0] === "del" && o[1] === "users/t1"), "old profile removed (old password stops working)");
  ok(log.findIndex(x => x[0] === "signOut") < log.findIndex(x => x[0] === "commit"), "admin stays signed in (helper app signed out)");

  await setup(false);
  const r = await p.evaluate(() => Cloud.resetPassword("slava", "zzzzzz").then(() => "done", e => e.code));
  ok(r === "permission-denied", "non-admin call is refused in code too");
  ok(errs.length === 0, `no page errors (${errs.join("; ") || "none"})`);
  await b.close(); console.log(`\n${f ? "✘ " + f + " FAILED" : "✔ all passed"} (${n} checks)`); process.exit(f ? 1 : 0);
})();
