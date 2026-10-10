// "פתק על המקרר" is not kept: once every recipient has read a note it is deleted; old notes everyone read are swept;
// my own notes nobody read in 30 days are deleted; nothing else is touched. Local only, Firebase mocked.
//   node tests/notes-vanish.test.cjs
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
    document.getElementById("splash")?.remove();
    const day = d => iso(new Date(Date.now() - d * 864e5)), E = ENV;
    window.__db = new Map(Object.entries({
      n1: { env: E, day: day(0), text: "אוהבת אותך", from: "T", to: ["S"], readBy: {} },                       // for me, unread
      n2: { env: E, day: day(0), text: "לכולם", from: "T", to: ["S", "K"], readBy: { K: 1 } },                   // K already read
      n3: { env: E, day: day(5), text: "ישן שכולם קראו", from: "T", to: ["S"], readBy: { S: 1 } },               // old, read → sweep
      n4: { env: E, day: day(40), text: "שלי, אף אחד לא קרא", from: "S", to: ["K"], readBy: {} },               // mine, 40 days → sweep
      n5: { env: E, day: day(2), text: "שלי, עוד לא נקרא", from: "S", to: ["K"], readBy: {} },                  // mine, recent → keep
      n6: { env: E, day: day(1), text: "בין אחרים", from: "T", to: ["K"], readBy: {} },                        // not mine at all → keep
    }));
    window.__del = [];
    const listeners = [];
    const emit = () => listeners.forEach(fn => fn());
    const match = (x, w) => w.op === "array-contains" ? (x[w.f] || []).includes(w.v) : x[w.f] === w.v;
    const snap = q => ({ docs: [...__db].filter(([id, x]) => q.where.every(w => match(x, w))).map(([id, x]) => ({ id, ref: id, data: () => JSON.parse(JSON.stringify(x)) })) });
    Cloud.user = { uid: "S" }; Cloud.fam = "home";
    Cloud.fb = {
      collection: () => "notes", doc: (db, ...a) => a.at(-1), where: (f, op, v) => ({ f, op, v }), query: (c, ...w) => ({ where: w }),
      onSnapshot: (q, fn) => { const run = () => fn(snap(q)); listeners.push(run); setTimeout(run, 0); return () => {}; },
      getDocs: async q => snap(q),
      updateDoc: async (id, patch) => { const x = __db.get(id); for (const [k, v] of Object.entries(patch)) { const [a, bb] = k.split("."); x[a][bb] = v; } setTimeout(emit, 0); },
      deleteDoc: async id => { if (!__db.has(id)) throw { code: "permission-denied" }; __del.push(id); __db.delete(id); setTimeout(emit, 0); },
    };
    Notes._swept = false; Notes.listen();
  });
  await p.waitForTimeout(600);
  let s = await p.evaluate(() => ({ left: [...__db.keys()].sort().join(), del: __del.slice().sort().join(), q: Notes.queue.map(x => x.id).concat(Notes.current ? [Notes.current] : []).join() }));
  ok(s.del === "n3,n4", `on open: the old note everyone read and my 30+ day unread note are deleted (${s.del})`);
  ok(/n1/.test(s.left) && /n2/.test(s.left) && /n5/.test(s.left) && /n6/.test(s.left), `everything else stays (${s.left})`);

  await p.evaluate(async () => { await Notes.ack({ id: "n1", ...__db.get("n1") }); });
  await p.waitForTimeout(300);
  ok(await p.evaluate(() => !__db.has("n1") && __del.includes("n1")), "reading a note sent only to me → deleted at once");
  await p.evaluate(async () => { await Notes.ack({ id: "n2", ...__db.get("n2") }); });
  await p.waitForTimeout(300);
  ok(await p.evaluate(() => !__db.has("n2")), "a note to two people: deleted when the second one reads it");

  await p.evaluate(() => { __db.set("n7", { env: ENV, day: iso(new Date()), text: "שניים", from: "T", to: ["S", "K"], readBy: {} }); });
  await p.evaluate(async () => { await Notes.ack({ id: "n7", ...__db.get("n7") }); });
  await p.waitForTimeout(300);
  ok(await p.evaluate(() => __db.has("n7") && !!__db.get("n7").readBy.S), "…but kept while someone else still hasn't read it");
  await p.evaluate(() => { __db.get("n7").readBy.K = 1; Cloud.fb.updateDoc("n7", {}); });       // K reads on their phone
  await p.waitForTimeout(400);
  ok(await p.evaluate(() => !__db.has("n7")), "when the last one reads it elsewhere, my app's sweep deletes it");
  ok(await p.evaluate(() => __db.has("n5") && __db.has("n6")), "my recent unread note and other people's notes are untouched");
  ok(errs.length === 0, `no page errors (${errs.join("; ") || "none"})`);
  await b.close(); console.log(`\n${f ? "✘ " + f + " FAILED" : "✔ all passed"} (${n} checks)`); process.exit(f ? 1 : 0);
})();
