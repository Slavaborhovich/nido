// Opening a task's file inside the app: photos full screen (tap to zoom), PDF pages drawn by pdf.js with a page
// counter, a preview of the first page in the file list, download, next file, the phone's back button closes it.
// Local only: pdf.js is served from the local copy instead of the CDN; everything else is blocked.
//   node tests/file-view.test.cjs
const path = require("path"), fs = require("fs");
const NM = fs.existsSync("/opt/npm-tools/node_modules") ? "/opt/npm-tools/node_modules" : path.join(__dirname, "..", "node_modules");
let chromium, PDFLib;
try { ({ chromium } = require("playwright")); } catch (e) { ({ chromium } = require(NM + "/playwright")); }
try { PDFLib = require("pdf-lib"); } catch (e) { PDFLib = require(NM + "/pdf-lib"); }
const FILE = process.env.NIDO_URL || ("file://" + path.join(__dirname, "..", "index.html"));
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const CDN = html.match(/const PDFJS = "([^"]+)"/)[1].replace(/(legacy\/)?build\/$/, ""), LOCAL = path.join(NM, "pdfjs-dist/");
const ver = html.match(/pdfjs-dist@([\d.]+)/)[1], have = JSON.parse(fs.readFileSync(path.join(NM, "pdfjs-dist/package.json"))).version;
const __cdn = []; let f = 0, n = 0; const ok = (c, m) => { console.log((c ? "  ✔ " : "  ✘ FAIL ") + m); c ? n++ : f++; };

(async () => {
  ok(ver === have, `the app asks for pdf.js ${ver} — the same version that is tested here (${have})`);
  const doc = await PDFLib.PDFDocument.create(), font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  for (const t of ["Ticket - page 1", "Ticket - page 2"]) { const pg = doc.addPage([420, 595]); pg.drawText(t, { x: 40, y: 520, size: 26, font }); pg.drawRectangle({ x: 40, y: 380, width: 120, height: 120, color: PDFLib.rgb(.1, .1, .1) }); }
  const pdf = { name: "כרטיסים.pdf", mimeType: "application/pdf", buffer: Buffer.from(await doc.save()) };

  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.route(/^https?:\/\//, r => { const u = r.request().url(); if (u.startsWith("http://127.0.0.1:")) return r.continue();
    if (u.startsWith(CDN)) { const fp = LOCAL + u.slice(CDN.length).split("?")[0]; if (!fs.existsSync(fp)) return r.fulfill({ status: 404, body: "" }); __cdn.push(u.slice(CDN.length));
      return r.fulfill({ status: 200, headers: { "content-type": /\.m?js$/.test(fp) ? "text/javascript" : /\.wasm$/.test(fp) ? "application/wasm" : "application/octet-stream", "access-control-allow-origin": "*" }, body: fs.readFileSync(fp) }); }
    return r.abort(); });
  await p.goto(FILE); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(400);
  await p.fill("#user", "slava"); await p.fill("#pass", "1234"); await p.click("#loginBtn"); await p.waitForTimeout(5000);
  await p.evaluate(() => { document.getElementById("splash")?.remove(); window.__t = []; toast = m => __t.push(m); go("tasks"); taskSheet(); });
  await p.waitForTimeout(400);
  const png = await p.evaluate(() => { const c = document.createElement("canvas"); c.width = 600; c.height = 400; const g = c.getContext("2d"); g.fillStyle = "#c33"; g.fillRect(0, 0, 600, 400); return c.toDataURL("image/png").split(",")[1]; });
  await p.fill("#tf input[name=title]", "הופעה"); await p.click('[data-r="files"]');
  await p.setInputFiles("#tkFile", [pdf, { name: "חניה.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") }, { name: "רשימה.txt", mimeType: "text/plain", buffer: Buffer.from("hello") }]);
  await p.waitForTimeout(3000);
  const th = await p.evaluate(() => ({ img: !!document.querySelector("#tkFiles img.tk-pdf"), meta: document.querySelector('#tkFiles [data-meta="0"]').textContent }));
  ok(th.img && /2 עמ׳/.test(th.meta), `the file list shows a picture of the PDF's first page (${th.meta})`);

  await p.click('#tkFiles [data-of="0"]'); await p.waitForTimeout(3000);
  const v = await p.evaluate(() => ({ open: !!FileView.el, pages: document.querySelectorAll(".fv .fv-page").length, sub: document.querySelector(".fv-t small").textContent,
    pg: document.querySelector("[data-pg]")?.textContent, cnt: document.querySelector(".fv .vw-cnt")?.textContent, ink: (() => { const c = document.querySelector(".fv-page"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let k = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 60) k++; return k; })() }));
  ok(v.open && v.pages === 2 && v.ink > 1000, `PDF opens inside the app, both pages drawn (${v.pages} pages)`);
  ok(__cdn.some(x => x.startsWith("standard_fonts/")), `fonts the PDF doesn't carry come from pdf.js's own free font files (${[...new Set(__cdn.map(x => x.split("/")[0] + "/" + x.split("/")[1]))].slice(0, 4).join(", ")})`);
  ok(await p.evaluate(() => [...document.querySelectorAll(".fv-page")].every(c => getComputedStyle(c).direction === "ltr")), "pages are drawn left-to-right (an RTL canvas shifts the PDF's letters)");
  ok(/2 עמודים/.test(v.sub) && v.pg === "עמוד 1 מתוך 2" && v.cnt === "1 / 3", `header "${v.sub}", counter "${v.pg}", file 1 / 3`);
  await p.evaluate(() => { const b = document.querySelector(".fv-body"); b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event("scroll")); }); await p.waitForTimeout(200);
  ok(await p.evaluate(() => document.querySelector("[data-pg]").textContent) === "עמוד 2 מתוך 2", "scrolling updates the page counter");
  const [dl] = await Promise.all([p.waitForEvent("download"), p.click("[data-down]")]);
  // headless Chromium on Linux names any blob download with a non-Latin name "download" (also in a 3-line page) — so the
  // name is checked only when it isn't that quirk; the content must be the original, byte for byte
  const got = fs.readFileSync(await dl.path()), name = dl.suggestedFilename();
  ok(Buffer.compare(got, pdf.buffer) === 0 && (name === "כרטיסים.pdf" || name === "download"), `"הורדה" saves the original file, byte for byte (${got.length} bytes, name "${name}")`);

  await p.click("[data-nextf]"); await p.waitForTimeout(400);
  ok(await p.evaluate(() => !!document.querySelector(".fv .fv-img") && document.querySelector(".fv .vw-cnt").textContent === "2 / 3"), "\"הקובץ הבא\" → the photo, full screen");
  await p.click(".fv-img"); ok(await p.evaluate(() => document.querySelector(".fv-body").classList.contains("zoom")), "tap on the photo zooms in");
  await p.click("[data-nextf]"); await p.waitForTimeout(300);
  ok(await p.evaluate(() => /אי אפשר להציג/.test(document.querySelector(".fv-other")?.textContent || "")), "another kind of file: a clear message + download / share");

  await p.evaluate(() => Back.pop()); await p.waitForTimeout(300);
  ok(await p.evaluate(() => !FileView.el && !!document.querySelector("#tf")), "the phone's back button closes the file and returns to the task");

  await p.unroute(/^https?:\/\//); await p.route(/^https?:\/\//, r => r.abort());
  await p.evaluate(() => { loadPdfJs.p = null; for (const k in pdfThumbs) delete pdfThumbs[k]; });
  const offline = await ctx.newPage(); await offline.close();
  await p.evaluate(() => FileView.open([{ img: "data:application/pdf;base64,JVBERi0xLjQK", name: "x.pdf", size: 9 }], 0));
  await p.waitForTimeout(800);
  ok(await p.evaluate(() => /לא הצלחתי להציג/.test(document.querySelector(".fv-other")?.textContent || "") && !!document.querySelector("[data-down]")), "if pdf.js can't load (offline): a clear message, download still works");
  ok(errs.length === 0, `no page errors (${errs.join("; ") || "none"})`);
  await b.close(); console.log(`\n${f ? "✘ " + f + " FAILED" : "✔ all passed"} (${n} checks)`); process.exit(f ? 1 : 0);
})();
