// "מזל טוב, מנהל המשפחה" shows ONCE per person and device — even though the app checks on every users update
// (which happens many times while it opens). Firebase mocked, no network.   node tests/admin-welcome.test.cjs
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
  await p.evaluate(() => { document.getElementById("splash")?.remove(); localStorage.clear();
    USERS.tehila = { name: "תהילה", role: "admin", color: "#C3B1FF", active: true, uid: "t1" }; me = "tehila";
    Cloud.user = { uid: "t1" }; Cloud.isSuper = false; $("#login").hidden = true; $("#app").hidden = false;
    for (let i = 0; i < 8; i++) famAdminWelcome(); });                       // 8 users updates while opening
  await p.waitForTimeout(1800);
  ok(await p.evaluate(() => document.querySelectorAll(".crown-scrim").length) === 1, "8 checks while opening → one popup");
  await p.evaluate(() => { famAdminWelcome(); famAdminWelcome(); document.querySelector(".crown-scrim .go").click(); });
  await p.waitForTimeout(5000);
  ok(await p.evaluate(() => document.querySelectorAll(".crown-scrim").length) === 0, "closed → it does not come back (checks that came while it was open wait for nothing)");
  await p.evaluate(() => { for (let i = 0; i < 5; i++) famAdminWelcome(); }); await p.waitForTimeout(3000);
  ok(await p.evaluate(() => document.querySelectorAll(".crown-scrim").length) === 0, "later users updates → still nothing");
  await p.reload(); await p.waitForTimeout(500);
  await p.evaluate(() => { document.getElementById("splash")?.remove();
    USERS.tehila = { name: "תהילה", role: "admin", color: "#C3B1FF", active: true, uid: "t1" }; me = "tehila";
    Cloud.user = { uid: "t1" }; Cloud.isSuper = false; $("#login").hidden = true; $("#app").hidden = false; famAdminWelcome(); });
  await p.waitForTimeout(2500);
  ok(await p.evaluate(() => document.querySelectorAll(".crown-scrim").length) === 0, "opening the app again → not shown again");
  ok(errs.length === 0, `no page errors (${errs.join("; ") || "none"})`);
  await b.close(); console.log(`\n${f ? "✘ " + f + " FAILED" : "✔ all passed"} (${n} checks)`); process.exit(f ? 1 : 0);
})();
