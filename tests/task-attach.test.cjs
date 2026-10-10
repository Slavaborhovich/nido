// Tasks: links, a place (typed or the device's location → Waze / Maps), files (photos shrunk, PDFs, size limit),
// saved only on "save", removed with the task, shared by a repeating task's next copy. Local demo mode, no network.
//   node tests/task-attach.test.cjs
const path = require("path"), fs = require("fs"), os = require("os");
let chromium;
try { ({ chromium } = require("playwright")); } catch (e) { ({ chromium } = require("/opt/npm-tools/node_modules/playwright")); }
const FILE = "file://" + path.join(__dirname, "..", "index.html");
let f = 0, n = 0; const ok = (c, m) => { console.log((c ? "  ✔ " : "  ✘ FAIL ") + m); c ? n++ : f++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nido-att-"));
const pdf = { name: "כרטיסים.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n" + "x".repeat(40000)) };
const big = { name: "big.zip", mimeType: "application/zip", buffer: Buffer.alloc(900 * 1024, 7) };

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, permissions: ["geolocation"], geolocation: { latitude: 32.08531, longitude: 34.78178 } });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.route(/^https?:\/\//, r => r.abort());
  await p.goto(FILE); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(400);
  await p.fill("#user", "slava"); await p.fill("#pass", "1234"); await p.click("#loginBtn"); await p.waitForTimeout(5000);
  await p.evaluate(() => { document.getElementById("splash")?.remove(); window.__t = []; toast = m => __t.push(m); go("tasks"); });
  const png = await p.evaluate(() => { const c = document.createElement("canvas"); c.width = 3000; c.height = 2000; const g = c.getContext("2d");
    for (let i = 0; i < 4000; i++){ g.fillStyle = `hsl(${i % 360},70%,${30 + i % 40}%)`; g.fillRect(Math.random() * 3000, Math.random() * 2000, 60, 60); } return c.toDataURL("image/png").split(",")[1]; });
  const photo = { name: "קבלה.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") };

  await p.evaluate(() => taskSheet()); await p.waitForTimeout(400);
  await p.fill("#tf input[name=title]", "כרטיסים להופעה");
  await p.click('[data-r="links"]'); await p.fill("#tkUrl", "eventim.co.il/concert"); await p.click("#tkUrlAdd");
  await p.fill("#tkUrl", "not a link at all"); await p.click("#tkUrlAdd");
  ok(await p.evaluate(() => document.querySelectorAll("#tkLinks .tk-it").length === 1 && __t.at(-1) === "זה לא נראה כמו קישור"), "a link is added (https:// added by itself); text that isn't a link is refused");
  await p.fill("#tkUrl", "");
  await p.click('[data-r="place"]'); await p.click("#tkHere"); await p.waitForTimeout(600);
  ok(await p.evaluate(() => document.querySelector("#tf input[name=place]").value === "32.08531, 34.78178" && /waze\.com\/ul\?ll=32\.08531%2C34\.78178/.test(document.querySelector("#tkNav").innerHTML)), "\"המיקום הנוכחי שלי\" fills the place → Waze / Maps buttons");
  await p.click('[data-r="files"]');
  await p.setInputFiles("#tkFile", [photo, pdf, big]); await p.waitForTimeout(4000);
  const pend = await p.evaluate(() => ({ rows: document.querySelectorAll("#tkFiles .tk-it").length, img: !!document.querySelector("#tkFiles img"), pdf: document.querySelector("#tkFiles .tk-doc")?.textContent, names: [...document.querySelectorAll("#tkFiles b")].map(x => x.textContent).join("|"), t: __t.at(-1), stored: JSON.parse(localStorage.getItem("nido.photos") || "[]").length }));
  ok(pend.rows === 2 && pend.img && pend.pdf === "PDF" && pend.names === "קבלה.jpg|כרטיסים.pdf", `photo (shrunk, Hebrew name kept) + PDF listed (${pend.names})`);
  ok(/גדול מדי/.test(pend.t || ""), `a file over the limit is refused with a clear message ("${pend.t}")`);
  ok(pend.stored === 0, "nothing stored before saving");
  await p.click("#tf [type=submit]"); await p.waitForTimeout(1200);
  const saved = await p.evaluate(() => { const t = DB.tasks.find(x => x.title === "כרטיסים להופעה"); const ph = JSON.parse(localStorage.getItem("nido.photos") || "[]").filter(x => x.ideaId === t.id);
    return { t, ph: ph.map(x => ({ id: x.id, mime: x.mime, len: x.img.length, name: x.name })) }; });
  ok(saved.t.links.join() === "https://eventim.co.il/concert" && saved.t.place === "32.08531, 34.78178" && saved.t.fileCount === 2, "saved: 1 link, the place, 2 files");
  ok(saved.ph.length === 2 && saved.ph.every(x => x.len < 900000) && saved.ph.some(x => x.mime === "image/jpeg") && saved.ph.some(x => x.mime === "application/pdf")
     && saved.ph.every(x => x.id === saved.t.id + "_" + x.id.split("_").pop()), `files stored like idea photos (id = task_seq, each < 900 KB: ${saved.ph.map(x => Math.round(x.len / 1024) + "KB").join(", ")})`);
  const row = await p.evaluate(id => document.querySelector(`.task[data-id="${id}"] .meta`).textContent, saved.t.id);
  ok(/מיקום/.test(row) && /1/.test(row) && /2/.test(row), `the task row shows 📍 🔗 📎 (${row.replace(/\s+/g, " ").trim()})`);

  await p.evaluate(id => taskSheet(DB.tasks.find(x => x.id === id)), saved.t.id); await p.waitForTimeout(600);
  ok(await p.evaluate(() => document.querySelectorAll("#tkFiles .tk-it").length === 2 && !document.querySelector('[data-f="files"]').hidden), "editing shows the stored files");
  await p.click('#tkFiles [data-xf="1"]'); await p.click("#tf [type=submit]"); await p.waitForTimeout(800);
  const after = await p.evaluate(id => ({ c: DB.tasks.find(x => x.id === id).fileCount, n: JSON.parse(localStorage.getItem("nido.photos") || "[]").filter(x => x.ideaId === id).length }), saved.t.id);
  ok(after.c === 1 && after.n === 1, "removing a file + save → really removed");

  await p.evaluate(id => { const t = DB.tasks.find(x => x.id === id); t.repeat = "weekly"; completeTask(t); }, saved.t.id);
  const rep = await p.evaluate(id => { const c = DB.tasks.find(x => x.spawned && x.title === "כרטיסים להופעה" && !x.done); return { owner: TaskFiles.owner(c), links: c.links.length, place: c.place, fc: c.fileCount }; }, saved.t.id);
  ok(rep.owner === saved.t.id && rep.links === 1 && rep.place && rep.fc === 1, "a repeating task's next copy keeps the link, place and files");
  await p.evaluate(() => { const c = DB.tasks.find(x => x.spawned && !x.done && x.title === "כרטיסים להופעה"); taskSheet(c); }); await p.waitForTimeout(500);
  await p.click("#del"); await p.waitForTimeout(500);
  ok(await p.evaluate(id => JSON.parse(localStorage.getItem("nido.photos") || "[]").filter(x => x.ideaId === id).length, saved.t.id) === 1, "deleting one copy keeps files the other copy still uses");
  await p.evaluate(id => { taskSheet(DB.tasks.find(x => x.id === id)); }, saved.t.id); await p.waitForTimeout(500);
  await p.click("#del"); await p.waitForTimeout(800);
  ok(await p.evaluate(id => JSON.parse(localStorage.getItem("nido.photos") || "[]").filter(x => x.ideaId === id).length, saved.t.id) === 0, "deleting the last task that uses them removes the files");

  await p.evaluate(() => taskSheet()); await p.waitForTimeout(400);
  await p.fill("#tf input[name=title]", "בלי צרופות"); await p.click("#tf [type=submit]"); await p.waitForTimeout(400);
  ok(await p.evaluate(() => { const t = DB.tasks.find(x => x.title === "בלי צרופות"); return !t.links.length && !t.place && !t.fileCount; }), "a plain task stays plain");
  ok(errs.length === 0, `no page errors (${errs.join("; ") || "none"})`);
  await b.close(); console.log(`\n${f ? "✘ " + f + " FAILED" : "✔ all passed"} (${n} checks)`); process.exit(f ? 1 : 0);
})();
