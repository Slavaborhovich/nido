/* Nido — notification server.
   notify:    runs on every change in envs/{prod|test}/{collection}/{id} and pushes to the other family members.
   reminders: every 5 minutes — an hour before timed events/tasks, plus an 08:00 summary of the day. */
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
setGlobalOptions({ region: "me-west1", maxInstances: 2, memory: "256MiB" });

const TZ = "Asia/Jerusalem";
const ENVS = ["prod", "test"];
const ADDED = { tasks: "משימה חדשה", ideas: "רעיון חדש", events: "אירוע חדש ביומן", shop: "נוסף לקניות", coupons: "קופון חדש", survey: "מוצר חדש בסקר שוק" };
const TAB = { tasks: "tasks", ideas: "ideas", events: "cal", shop: "shop", coupons: "shop", survey: "shop" };

async function family() {
  const qs = await db.collection("users").get();
  return qs.docs.map(d => ({ uid: d.id, ...d.data() })).filter(u => u.active !== false);
}
const wants = (u, kind) => !(u.notif && u.notif[kind] === false);

async function send(env, uids, { title, body, tag, tab }) {
  uids = [...new Set(uids)].filter(Boolean);
  if (!uids.length) return;
  const qs = await db.collection("devices").where("env", "==", env).get();
  const tokens = qs.docs.filter(d => uids.includes(d.data().uid)).map(d => d.id);
  if (!tokens.length) return;
  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    data: { title: String(title || "Nido"), body: String(body || ""), tag: String(tag || ""), tab: String(tab || "") },
    webpush: { headers: { Urgency: "high", TTL: "86400" } },
  });
  await Promise.all(res.responses.map((r, i) => {
    const code = (r.error && r.error.code) || "";
    if (!r.success && /not-registered|invalid-registration-token|invalid-argument/.test(code)) return db.doc(`devices/${tokens[i]}`).delete().catch(() => {});
    return null;
  }));
}

exports.notify = onDocumentWritten({ document: "envs/{env}/{col}/{id}", region: "me-west1" }, async ev => {
  const { env, col, id } = ev.params;
  if (!ENVS.includes(env)) return;
  const before = ev.data.before.exists ? ev.data.before.data() : null;
  const after = ev.data.after.exists ? ev.data.after.data() : null;
  if (!after) return;                                         // deletions: silent

  const people = await family();
  const actor = people.find(u => u.uid === after._by);
  const who = actor ? actor.name : "מישהו";
  const others = people.filter(u => u.uid !== after._by);
  const byName = Object.fromEntries(people.map(u => [u.username, u]));
  const label = after.title || after.name || "";
  const jobs = [];

  if (!before) {
    // tasks the app creates on its own aren't news
    if (col === "tasks" && (after.spawned || after.kind === "idea" || after.kind === "survey")) return;
    if (col === "tasks" && after.kind === "shop") {
      jobs.push(send(env, others.filter(u => wants(u, "done")).map(u => u.uid),
        { title: "יוצאים לקניות 🛒", body: `${who} לוקח/ת את הקניות`, tag: "shop-take", tab: "shop" }));
      return Promise.all(jobs);
    }
    const assignee = col === "tasks" && after.assignee ? byName[after.assignee] : null;
    if (assignee && assignee.uid !== after._by && wants(assignee, "assigned"))
      jobs.push(send(env, [assignee.uid], { title: "שובצה לך משימה", body: `${label} · מ${who}`, tag: `t-${id}`, tab: "tasks" }));
    jobs.push(send(env, others.filter(u => wants(u, "added") && u !== assignee).map(u => u.uid),
      { title: ADDED[col] || "נוסף משהו חדש", body: `${who}: ${label}`, tag: col === "shop" ? "shop-add" : `n-${id}`, tab: TAB[col] }));
    return Promise.all(jobs);
  }

  if (col === "tasks") {
    if (after.assignee && after.assignee !== before.assignee) {
      const a = byName[after.assignee];
      if (a && a.uid !== after._by && wants(a, "assigned"))
        jobs.push(send(env, [a.uid], { title: "שובצה לך משימה", body: `${label} · מ${who}`, tag: `t-${id}`, tab: "tasks" }));
    }
    if (after.done && !before.done) {
      const isShop = after.kind === "shop";
      jobs.push(send(env, others.filter(u => wants(u, "done")).map(u => u.uid), {
        title: isShop ? "הקניות הושלמו ✓" : "משימה הושלמה ✓",
        body: isShop ? `${who} סיים/ה את הקניות` : `${who}: ${label}`, tag: `d-${id}`, tab: "tasks",
      }));
    }
  }
  return Promise.all(jobs);
});

/* ---------- reminders ---------- */
function localNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: (+p.hour) * 60 + (+p.minute) };
}
const toMin = t => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ""); return m ? (+m[1]) * 60 + (+m[2]) : null; };
async function once(key) {                                    // true the first time only
  try { await db.doc(`reminders/${key}`).create({ at: Date.now() }); return true; } catch (e) { return false; }
}

exports.reminders = onSchedule({ schedule: "every 5 minutes", timeZone: TZ, region: "me-west1" }, async () => {
  const now = localNow();
  const people = await family();
  const byName = Object.fromEntries(people.map(u => [u.username, u]));
  const remind = people.filter(u => wants(u, "remind"));

  for (const env of ENVS) {
    const base = db.collection("envs").doc(env);
    const [evs, tks] = await Promise.all([
      base.collection("events").where("date", "==", now.date).get(),
      base.collection("tasks").where("date", "==", now.date).get(),
    ]);
    const events = evs.docs.map(d => ({ id: d.id, ...d.data() }));
    const tasks = tks.docs.map(d => ({ id: d.id, ...d.data() })).filter(t => !t.done);

    // an hour before
    for (const it of [...events.map(e => ({ ...e, col: "events" })), ...tasks.map(t => ({ ...t, col: "tasks" }))]) {
      const m = toMin(it.time); if (m === null) continue;
      const diff = m - now.min;
      if (diff <= 0 || diff > 60) continue;
      if (!(await once(`${env}_${it.col}_${it.id}_${now.date}_${it.time.replace(":", "")}`))) continue;
      const to = it.col === "tasks" && byName[it.assignee] ? remind.filter(u => u.username === it.assignee) : remind;
      await send(env, to.map(u => u.uid), {
        title: it.col === "events" ? `בעוד ${diff} דק׳: ${it.title}` : `תזכורת: ${it.title}`,
        body: it.col === "events" ? `${it.time}${it.place ? " · " + it.place : ""}` : `היום ב־${it.time}`,
        tag: `r-${it.id}`, tab: it.col === "events" ? "cal" : "tasks",
      });
    }

    // 08:00 summary, once a day per person
    if (now.min >= 8 * 60 && now.min < 12 * 60) {
      for (const u of remind) {
        const mine = [
          ...events.map(e => (e.time ? `${e.time} ` : "") + e.title),
          ...tasks.filter(t => !t.assignee || t.assignee === u.username).map(t => (t.time ? `${t.time} ` : "") + t.title),
        ];
        if (!mine.length) continue;
        if (!(await once(`${env}_digest_${now.date}_${u.uid}`))) continue;
        await send(env, [u.uid], {
          title: `בוקר טוב ${u.name} ☀️ ${mine.length === 1 ? "דבר אחד היום" : mine.length + " דברים היום"}`,
          body: mine.slice(0, 4).join(" · ") + (mine.length > 4 ? " …" : ""), tag: "digest", tab: "today",
        });
      }
    }
  }
});
