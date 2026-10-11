// Events: links + files (same free storage as task files), shown in the event window, removed with the event.
// Local demo mode, no network.   node tests/event-attach.test.cjs
const path = require("path");
let chromium;
try { ({ chromium } = require("playwright")); } catch (e) { ({ chromium } = require("/opt/npm-tools/node_modules/playwright")); }
const FILE = "file://" + path.join(__dirname, "..", "index.html");
let f = 0, n = 0; const ok = (c, m) => { console.log((c ? "  ✔ " : "  ✘ FAIL ") + m); c ? n++ : f++; };
const pdf = { name: "הזמנה.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n" + "x".repeat(20000)) };
const big = { name: "big.zip", mimeType: "application/zip", buffer: Buffer.alloc(900 * 1024, 7) };

(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.route(/^https?:\/\//, r => r.abort());
  await p.goto(FILE); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(400);
  await p.fill("#user", "slava"); await p.fill("#pass", "1234"); await p.click("#loginBtn"); await p.waitForTimeout(5000);
  await p.evaluate(() => { document.getElementById("splash")?.remove(); window.__t = []; toast = m => __t.push(m); askConfirm = async () => true; go("cal"); });
  const png = await p.evaluate(() => { const c = document.createElement("canvas"); c.width = 800; c.height = 600; const g = c.getContext("2d"); g.fillStyle = "#c96"; g.fillRect(0, 0, 800, 600); return c.toDataURL("image/png").split(",")[1]; });
  const photo = { name: "מפה.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") };
  const photos = () => p.evaluate(() => JSON.parse(localStorage.getItem("nido.photos") || "[]"));

  await p.evaluate(() => eventSheet(null, { date: iso(new Date()) })); await p.waitForTimeout(400);
  ok(await p.evaluate(() => !!document.querySelector("#ef .ev-att #tkUrl") && !!document.querySelector("#ef #tkFile")), "the event window has a links-and-files section");
  await p.fill("#ef input[name=title]", "חתונה של דנה");
  await p.fill("#tkUrl", "dana-wedding.co.il/rsvp"); await p.click("#tkUrlAdd");
  await p.fill("#tkUrl", "לא קישור"); await p.click("#tkUrlAdd");
  ok(await p.evaluate(() => document.querySelectorAll("#tkLinks .tk-it").length === 1 && __t.at(-1) === "זה לא נראה כמו קישור"), "a link is added; text that isn't a link is refused");
  await p.fill("#tkUrl", "waze.com/ul?q=x");        // typed but not added with ＋ → still saved
  await p.setInputFiles("#tkFile", [photo, pdf, big]); await p.waitForTimeout(2500);
  ok(await p.evaluate(() => document.querySelectorAll("#tkFiles .tk-it").length === 2 && /גדול מדי/.test(__t.at(-1))), "photo + PDF listed, a too-big file refused");
  ok((await photos()).length === 0, "nothing stored before saving");
  await p.click("#ef [type=submit]"); await p.waitForTimeout(1200);
  const ev = await p.evaluate(() => DB.events.find(x => x.title === "חתונה של דנה"));
  const ph = (await photos()).filter(x => x.ideaId === ev.id);
  ok(ev.links.join() === "https://dana-wedding.co.il/rsvp,https://waze.com/ul?q=x" && ev.fileCount === 2 && ev.fileOwner === ev.id, `saved: 2 links (incl. the one left in the box), 2 files`);
  ok(ph.length === 2 && ph.every(x => x.id === ev.id + "_" + x.seq && x.img.length < 900000), "files stored like task files (id = event_seq, < 900 KB each)");

  await p.evaluate(id => eventView(DB.events.find(x => x.id === id)), ev.id); await p.waitForTimeout(800);
  const v = await p.evaluate(() => ({ links: [...document.querySelectorAll(".evv .ev-lk")].map(a => a.getAttribute("href")), files: document.querySelectorAll("#evFiles .tk-open").length }));
  ok(v.links.length === 2 && v.files === 2, `the event window shows the links and the files (${v.links.length} + ${v.files})`);
  await p.click('#evFiles [data-of="0"]'); await p.waitForTimeout(500);
  ok(await p.evaluate(() => !!document.querySelector(".fv.show, .vw.fv")), "tapping a file opens it full screen");
  await p.evaluate(() => FileView.close()); await p.waitForTimeout(300);

  await p.evaluate(() => closeSheet()); await p.waitForTimeout(400);
  await p.evaluate(id => eventSheet(DB.events.find(x => x.id === id)), ev.id); await p.waitForTimeout(700);
  ok(await p.evaluate(() => document.querySelectorAll("#tkFiles .tk-it").length === 2 && document.querySelectorAll("#tkLinks .tk-it").length === 2), "editing shows the stored links and files");
  await p.click('#tkFiles [data-xf="0"]'); await p.click('#tkLinks [data-xl="1"]'); await p.click("#ef [type=submit]"); await p.waitForTimeout(900);
  const e2 = await p.evaluate(id => DB.events.find(x => x.id === id), ev.id);
  ok(e2.fileCount === 1 && e2.links.length === 1 && (await photos()).filter(x => x.ideaId === ev.id).length === 1, "removing a file and a link + save → really removed");

  await p.evaluate(id => eventView(DB.events.find(x => x.id === id)), ev.id); await p.waitForTimeout(500);
  await p.click("#del"); await p.waitForTimeout(800);
  ok(await p.evaluate(id => !DB.events.some(x => x.id === id), ev.id) && (await photos()).filter(x => x.ideaId === ev.id).length === 0, "deleting the event deletes its files too");
  ok(errs.length === 0, `no page errors (${errs.join("; ") || "none"})`);
  await b.close(); console.log(`\n${f ? "✘ " + f + " FAILED" : "✔ all passed"} (${n} checks)`); process.exit(f ? 1 : 0);
})();
