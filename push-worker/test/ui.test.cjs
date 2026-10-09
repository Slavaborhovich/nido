// Admin screen: the notification switch must never claim success the server did not confirm.
// Local only: loads the real index.html in headless Chromium with every network request intercepted
// (no Firebase, no Cloudflare). Needs Playwright:  node push-worker/test/ui.test.cjs
const fs = require("fs"), path = require("path"), os = require("os");
let chromium;
try { ({ chromium } = require("playwright")); } catch (e) { ({ chromium } = require("/opt/npm-tools/node_modules/playwright")); }

const ROOT = path.join(__dirname, "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nido-ui-"));
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const withUrl = u => html.replace(/^const PUSH_URL = "[^"]*";/m, `const PUSH_URL = "${u}";`);
fs.writeFileSync(path.join(tmp, "ready.html"), withUrl("https://worker.test"));                       // server set up (mocked)
fs.writeFileSync(path.join(tmp, "notready.html"), withUrl("__PUSH_URL__"));                           // no server address

let failures = 0, passed = 0;
const ok = (c, m) => { console.log((c ? "  ✔ " : "  ✘ FAIL ") + m); if (c) passed++; else failures++; };

(async () => {
  const browser = await chromium.launch();
  let mode = "ok", calls = []; const dbOff = {};                        // what the mock server "reads" from the database
  async function open(file) {
    const page = await browser.newPage();
    calls = [];
    await page.route(/^https?:\/\//, async route => {
      const url = route.request().url();
      if (!url.startsWith("https://worker.test/")) return route.abort();
      const body = JSON.parse(route.request().postData() || "{}"); calls.push({ path: new URL(url).pathname, body });
      if (mode === "down") return route.abort();                                                    // server unreachable
      if (mode === "503") return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"busy"}' });
      const fams = {};
      if (body.fam) {
        const off = body.off === true || body.frozen === true || dbOff[body.fam] === true;
        fams[body.fam] = mode === "unverified" ? { on: false, act: true, allowed: false, verified: false, until: Date.now() + 48 * 3600e3 }
          : mode === "stale" ? { on: true, act: true, allowed: true, verified: true, until: Date.now() + 48 * 3600e3 }   // server still says "on"
          : { on: !off, act: body.frozen !== true, allowed: !off, verified: true, until: Date.now() + 48 * 3600e3 };
      } else for (const f of ["home", "fB"]) fams[f] = { on: f === "home", act: true, allowed: f === "home", verified: true, until: Date.now() + 48 * 3600e3 };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, primary: "home", families: fams }) });
    });
    await page.goto("file://" + path.join(tmp, file) + "?cloud=1");
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      document.getElementById("splash")?.remove();
      try { localStorage.clear(); } catch (e) {}
      window.__toasts = []; toast = m => window.__toasts.push(m); askConfirm = async () => true;
      window.__saveFail = false;
      Cloud.isSuper = true; Cloud.user = { uid: BOOT_ADMIN_UID }; Cloud.auth = { currentUser: { getIdToken: async () => "token" } };
      Cloud.fb = {
        doc: (db, ...p) => p.join("/"),
        setDoc: async (ref, patch) => { if (window.__saveFail) throw { code: "permission-denied" }; Object.assign(FAMILIES[ref.split("/")[1]], patch); },
        writeBatch: () => { const o = []; return { update(r, d) { o.push([r, d]); }, set(r, d) { o.push([r, d]); }, async commit() { for (const [r, d] of o) if (r.startsWith("families/")) Object.assign(FAMILIES[r.split("/")[1]], d); } }; },
      };
      Object.keys(FAMILIES).forEach(k => delete FAMILIES[k]);
      Object.assign(FAMILIES, { home: { name: "בורחוביץ'", push: true }, fB: { name: "בדיקות", push: true } });
      Object.keys(ALLUSERS).forEach(k => delete ALLUSERS[k]);
      Object.assign(ALLUSERS, { slava: { uid: BOOT_ADMIN_UID, family: "home", name: "סלבה", color: "#F2B66B", role: "admin", active: true }, t1: { uid: "t1", family: "fB", name: "ב", color: "#F2B66B", role: "admin", active: true } });
      $("#admin").hidden = false; document.body.classList.add("admin-open"); S.adminTab = "push"; Admin.render();
    });
    return page;
  }
  const flip = async (page, fid) => { await page.evaluate(f => { const c = document.querySelector(`[data-push="${f}"]`); c.checked = !c.checked; c.onchange(); }, fid); await page.waitForTimeout(300); };
  const st = (page, fid) => page.evaluate(f => ({ toasts: window.__toasts.slice(), line: PushPolicy.line(f), pending: PushPolicy.pending(), checked: document.querySelector(`[data-push="${f}"]`).checked, push: FAMILIES[f].push }), fid);

  console.log("\nAdmin screen — notification switch");
  let page = await open("ready.html");
  mode = "ok"; await flip(page, "fB"); let s = await st(page, "fB");
  ok(s.toasts.at(-1) === "אומת בשרת: ההתראות הושבתו" && s.line.includes("אומת בשרת") && !s.pending.length, `server confirmed → "אומת בשרת" (${s.toasts.at(-1)})`);
  await page.close();

  for (const [m, label] of [["down", "server unreachable"], ["503", "server answers 503"], ["unverified", "server could not verify"], ["stale", "server still says 'on'"]]) {
    page = await open("ready.html"); mode = m;
    await flip(page, "fB"); s = await st(page, "fB");
    ok(!s.toasts.some(t => t.includes("אומת")) && s.toasts.at(-1).includes("ממתין לאימות"), `${label} → no success message ("${s.toasts.at(-1)}")`);
    ok(s.push === false && s.checked === false && s.line.includes("ממתין לאימות") && s.pending.includes("fB"), `${label} → shows "saved, waiting for the server" and keeps it pending`);
    if (m === "down") {
      mode = "ok"; dbOff.fB = true; await page.evaluate(() => PushPolicy.all(true)); delete dbOff.fB; s = await st(page, "fB");
      ok(s.line.includes("אומת בשרת") && !s.pending.length, "server back → the retry confirms it (pending cleared)");
    }
    await page.close();
  }

  page = await open("ready.html"); mode = "ok";
  await page.evaluate(() => { window.__saveFail = true; }); const n0 = calls.length;
  await flip(page, "fB"); s = await st(page, "fB");
  ok(s.checked === true && s.push === true && calls.length === n0 && !s.toasts.at(-1).includes("נשמר"), `database write refused → switch goes back, nothing claimed ("${s.toasts.at(-1)}")`);
  await page.close();

  page = await open("ready.html"); mode = "ok";
  ok(await page.evaluate(() => document.querySelector('[data-push="home"]').disabled), "the primary family's switch can't be turned off");
  await page.close();

  page = await open("ready.html"); mode = "down";
  await page.evaluate(async () => { S.adminTab = "fams"; S.adminFam = "fB"; Admin.render(); document.querySelector("[data-active]").click(); });
  await page.waitForTimeout(400); s = await st(page, "fB").catch(() => null);
  const t = await page.evaluate(() => window.__toasts.at(-1));
  ok(t === "המשפחה הושבתה · ממתין לאימות שרת ההתראות", `freezing with the server unreachable says so ("${t}")`);
  await page.close();

  page = await open("notready.html");
  await flip(page, "fB"); s = await st(page, "fB");
  ok(s.toasts.at(-1) === "נשמר. ייכנס לתוקף כשהשרת יופעל" && calls.length === 0, "server not set up yet → \"saved\", no server call, no false claim");
  const keys = await page.evaluate(async () => { const before = performance.getEntriesByType("resource").length; document.querySelector("details").open = true; document.querySelector("[data-vapid]").click(); await new Promise(r => setTimeout(r, 300)); return { pub: document.querySelector("[data-vk=pub]").value, priv: document.querySelector("[data-vk=priv]").value, req: performance.getEntriesByType("resource").length - before }; });
  ok(keys.pub.length === 87 && keys.priv.length === 43 && keys.req === 0 && calls.length === 0, `key pair made in the browser (public ${keys.pub.length} chars, private ${keys.priv.length}), no network request`);
  await page.close();

  await browser.close();
  console.log(`\n${failures ? "✘ " + failures + " FAILED" : "✔ all passed"} (${passed} checks)`);
  process.exit(failures ? 1 : 0);
})();
