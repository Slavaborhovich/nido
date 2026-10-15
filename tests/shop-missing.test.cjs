// קניות: the family's own lists (made by the manager) + "לא היה בחנות". Local demo mode, no network.   node tests/shop-missing.test.cjs
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
  await p.fill("#user", "slava"); await p.fill("#pass", "1234"); await p.click("#loginBtn"); await p.waitForTimeout(4500);
  await p.evaluate(() => { document.getElementById("splash")?.remove(); window.__t = []; toast = m => __t.push(m); go("shop"); });
  await p.waitForTimeout(400);
  const R = (js, a) => p.evaluate(js, a);

  ok(await R(() => [...document.querySelectorAll(".sh-card")].map(x => x.dataset.sl).join() === "super,home,noam" && !DB.shoplists.length), "a family with no lists of its own sees the three built-in lists");
  ok(await R(() => !!document.getElementById("newList") && document.querySelectorAll(".sh-edit").length === 3), "the manager sees ＋ רשימה חדשה and an edit button on each list");

  // a new list
  await p.click("#newList"); await p.waitForTimeout(300);
  ok(await R(() => document.querySelector("#lf [type=submit]").disabled), "יצירת רשימה waits for a name");
  await p.fill('#lf input[name=name]', "סופר פארם"); await p.click('#lf [data-pic="pill"]'); await p.click('#lf [data-col="pink"]');
  await p.click("#lf [type=submit]"); await p.waitForTimeout(400);
  const pharm = await R(() => DB.shoplists.find(x => x.name === "סופר פארם"));
  ok(pharm && pharm.pic === "pill" && pharm.color === "pink", "the new list keeps its name, picture and colour");
  ok(await R(() => DB.shoplists.map(x => x.id).slice(0, 3).join() === "super,home,noam"), "the built-in lists became the family's own, unchanged");
  ok(await R(id => { const c = document.querySelector(`[data-sl="${id}"]`); return c && c.querySelector(".flu").src.endsWith("pill.png") && c.getAttribute("style").includes("#F0A8C8"); }, pharm.id), "its card shows the pill picture in pink");
  await p.fill('.sh-add input[name=name]', "סימילאק 2"); await p.press('.sh-add input[name=name]', "Enter"); await p.waitForTimeout(300);
  ok(await R(id => DB.shop.some(i => i.name === "סימילאק 2" && i.list === id), pharm.id), "a new list opens ready to add to");
  ok(await R(id => !!document.querySelector(`#if`) || [...document.querySelectorAll('.sh-card')].length === 4, pharm.id), "four lists on the screen");
  // "לקנות…" offers it too
  await R(() => { window.__al = askList("לקנות משחת שיניים"); }); await p.waitForTimeout(300);
  ok(await R(id => !!document.querySelector(`.al-row [data-l="${id}"]`), pharm.id), "\"לקנות …\" offers the new list");
  await R(id => document.querySelector(`.al-row [data-l="${id}"]`).click(), pharm.id); await p.waitForTimeout(300);

  // rename
  await R(id => document.querySelector(`[data-edit="${id}"]`).click(), pharm.id); await p.waitForTimeout(300);
  await p.fill('#lf input[name=name]', "פארם"); await p.click("#lf [type=submit]"); await p.waitForTimeout(300);
  ok(await R(id => DB.shoplists.find(x => x.id === id).name === "פארם", pharm.id), "a list can be renamed");

  // delete: blocked while it has items
  await R(id => document.querySelector(`[data-edit="${id}"]`).click(), pharm.id); await p.waitForTimeout(300);
  await p.click("#ldel"); await p.waitForTimeout(300);
  ok(await R(id => DB.shoplists.some(x => x.id === id) && __t.at(-1).includes("פריטים"), pharm.id), "a list with items can't be deleted");
  await R(() => closeSheet()); await p.waitForTimeout(300);

  // missing: I take milk, it's not in the store, it moves to the new list
  await R(() => { document.querySelector('[data-sl="super"] .box').click(); }); await p.waitForTimeout(200);
  await R(() => document.getElementById("takeOk").click()); await p.waitForTimeout(300);
  const milk = await R(() => DB.shop.find(i => i.takenBy === me).id);
  await R(id => itemSheet(DB.shop.find(i => i.id === id)), milk); await p.waitForTimeout(300);
  ok(await R(() => !!document.getElementById("miss")), "the item window has \"לא היה בחנות\"");
  await p.click("#miss"); await p.waitForTimeout(300);
  ok(await R(() => document.querySelector('#mf input[name=to]:checked').value === "super"), "default: stay in the list it was missing from");
  await R(id => document.querySelector(`#mf input[name=to][value="${id}"]`).click(), pharm.id);
  await p.click("#mf [type=submit]"); await p.waitForTimeout(400);
  const m = await R(id => DB.shop.find(i => i.id === id), milk);
  ok(m.missing && m.missing.where === "super" && m.list === pharm.id, "marked missing in the supermarket and moved to the new list");
  ok(!m.takenBy && !m.taskId && await R(() => !DB.tasks.some(t => t.kind === "shop" && !t.done)), "it left my shopping task (the empty task is gone)");
  ok(await R(id => { const li = document.querySelector(`[data-sl="${id}"] li.miss`); return li && li.textContent.includes("לא היה בסופר · היום") && !!li.querySelector(".mmove") && !!document.querySelector(`[data-sl="${id}"] .miss-h`); }, pharm.id), "it shows at the bottom of its card under חסר בחנות, with העברה");

  // stay + finish: a missing item survives the end of the trip
  await R(() => { document.querySelector('[data-sl="super"] li:not(.miss) .box').click(); }); await p.waitForTimeout(200);
  await R(() => document.getElementById("takeOk").click()); await p.waitForTimeout(300);
  const bread = await R(() => DB.shop.find(i => i.takenBy === me).id);
  await R(() => { document.querySelector('[data-sl="super"] li:not(.miss) .box:not(.on)').click(); }); await p.waitForTimeout(200);
  await R(() => document.getElementById("takeOk").click()); await p.waitForTimeout(300);
  await R(id => itemSheet(DB.shop.find(i => i.id === id)), bread); await p.waitForTimeout(300);
  await p.click("#miss"); await p.waitForTimeout(300); await p.click("#mf [type=submit]"); await p.waitForTimeout(300);
  await R(() => completeTask(myShopTask())); await p.waitForTimeout(300);
  ok(await R(id => { const i = DB.shop.find(x => x.id === id); return i && i.list === "super" && i.missing && !i.taskId; }, bread), "finishing the trip keeps the missing item in its list");
  ok(await R(() => !DB.shop.some(i => i.name === "ביצים") && DB.shop.filter(i => i.list === "super" && !i.missing).length === 2), "…while what was bought came off the list");

  // move button + clear
  await R(id => document.querySelector(`[data-move="${id}"]`).click(), bread); await p.waitForTimeout(300);
  await R(() => document.querySelector('[data-to="home"]').click()); await p.waitForTimeout(300);
  ok(await R(id => DB.shop.find(x => x.id === id).list === "home", bread), "העברה moves a missing item to another list");
  await R(id => itemSheet(DB.shop.find(i => i.id === id)), bread); await p.waitForTimeout(300);
  await p.click("#unmiss"); await p.waitForTimeout(300);
  ok(await R(id => !DB.shop.find(x => x.id === id).missing, bread), "the \"חסר\" mark can be cleared");

  // empty list → delete
  await R(id => { DB.shop = DB.shop.filter(i => shopKey(i.list) !== id); save(); renderShop(); }, pharm.id); await p.waitForTimeout(200);
  await R(id => document.querySelector(`[data-edit="${id}"]`).click(), pharm.id); await p.waitForTimeout(300);
  await p.click("#ldel"); await p.waitForTimeout(400);
  await R(() => document.querySelector(".cfm .del")?.click()); await p.waitForTimeout(400);
  ok(await R(id => !DB.shoplists.some(x => x.id === id) && !document.querySelector(`[data-sl="${id}"]`), pharm.id), "an empty list can be deleted");

  // an editor (not a manager) can't manage lists
  await R(() => { USERS[me].role = "editor"; renderShop(); }); await p.waitForTimeout(200);
  ok(await R(() => !document.getElementById("newList") && !document.querySelector(".sh-edit")), "a regular member doesn't see list management");
  await R(() => { USERS[me].role = "admin"; });

  ok(!errs.length, `no page errors (${errs.join(" | ") || "none"})`);
  await b.close();
  console.log(f ? `\n✘ ${f} failed, ${n} passed` : `\n✔ all passed (${n} checks)`); process.exit(f ? 1 : 0);
})();
