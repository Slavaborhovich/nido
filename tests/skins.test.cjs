// Skins (My look): Nido Home / Nido Light, saved per user, per-screen photos. Local demo mode, no network.
//   node tests/skins.test.cjs
const path = require("path");
let chromium;
try { ({ chromium } = require("playwright")); } catch (e) { ({ chromium } = require("/opt/npm-tools/node_modules/playwright")); }
const FILE = "file://" + path.join(__dirname, "..", "index.html");
let f = 0; const ok = (c, m) => { console.log((c ? "  ✔ " : "  ✘ FAIL ") + m); if (!c) f++; };
(async () => {
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await p.clock.install({ time: new Date("2026-10-08T10:30:00+03:00") });
  const ext = []; await p.route(/^https?:\/\//, r => { ext.push(r.request().url()); r.abort(); });
  await p.goto(FILE); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.clock.runFor(400);
  const login = async u => { await p.fill("#user", u); await p.fill("#pass", "1234"); await p.click("#loginBtn"); await p.clock.runFor(6000); await p.evaluate(() => document.getElementById("splash")?.remove()); };
  const skin = () => p.evaluate(() => document.documentElement.dataset.skin || "home");
  await login("slava");
  ok(await skin() === "home", "a new user starts with Nido Home");
  await p.evaluate(() => openProfile()); await p.clock.runFor(500);
  await p.evaluate(() => document.querySelector("#lookBtn").click()); await p.clock.runFor(500);
  await p.evaluate(() => document.querySelector('[data-pick="light"]').click()); await p.clock.runFor(800);
  ok(await skin() === "light", "picking Nido Light applies it at once (no reload, no re-login)");
  ok(await p.evaluate(() => USERS.slava.skin === "light" && localStorage.getItem("nido.skin") === "light"), "saved on the user's own record + on the device");
  ok(await p.evaluate(() => [...document.querySelectorAll("#ambient .main")].some(i => i.getAttribute("src") === "bg/today.jpg")), "the screen's own photo is shown (today)");
  await p.evaluate(() => { closeSheet(); S.tab = "shop"; render(); }); await p.clock.runFor(2500);
  ok(await p.evaluate(() => [...document.querySelectorAll("#ambient .main")].some(i => i.getAttribute("src") === "bg/shop.jpg")), "switching screen switches the photo (shop)");
  await p.evaluate(() => logout()); await p.clock.runFor(1500);
  await login("tehila");
  ok(await skin() === "home", "same device, another user: Tehila sees Home, not Slava's Light");
  await p.evaluate(() => Skin.choose("home")); await p.clock.runFor(400);
  ok(await skin() === "home" && await p.evaluate(() => USERS.tehila.skin === "home" && USERS.slava.skin === "light"), "Tehila → Home, Slava stays Light (no overwrite)");
  await p.evaluate(() => logout()); await p.clock.runFor(1500);
  await login("slava");
  ok(await skin() === "light", "Slava signs in again → his saved Light comes back");
  await p.evaluate(() => { openProfile(); document.querySelector("#lookBtn").click(); }); await p.clock.runFor(500);
  await p.evaluate(() => document.querySelector("#skinReset").click()); await p.clock.runFor(500);
  ok(await skin() === "home" && await p.evaluate(() => USERS.slava.skin === "home"), "'חזרה לברירת המחדל' returns to Nido Home and saves it");
  ok(ext.filter(u => !/gstatic|googleapis|fonts/.test(u)).length === 0, `no new outside requests (${ext.filter(u => !/gstatic|googleapis|fonts/.test(u)).join(" ") || "none"})`);
  await b.close(); console.log(f ? `✘ ${f} FAILED` : "✔ all passed"); process.exit(f ? 1 : 0);
})();
