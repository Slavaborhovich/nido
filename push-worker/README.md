# Nido push server (Cloudflare Worker)

**Iron rule: 0 ₪.** Workers **Free** plan only. No credit card, no payment method, no Workers Paid,
no Durable Objects / Queues / D1 / R2. If Cloudflare ever asks for a card to continue — stop.
Nothing here guarantees that a provider will never charge; it only avoids everything that is documented as paid.

Everything below is a plan. Each step needs the owner's explicit approval before it is done.

## What it uses (all free)
| Resource | Free-plan limit (Cloudflare docs) | Our use (one family, 2 phones — estimates) |
|---|---|---|
| Worker requests | 100,000 / day | app calls + 1,440 cron runs |
| CPU | 10 ms per invocation (HTTP and cron) | HTTP: no encryption at all. Cron: ≤ 3 pushes per run. **Not measured on Cloudflare** — see "CPU" |
| Subrequests | 50 per invocation (every `fetch` and every KV call) | hard budget of 30 in code; tests max 30 |
| Cron Triggers | 5 per account | 1 (`* * * * *`) |
| KV reads | 100,000 / day | ≈ 6–8 per minute ≈ 11,500 / day |
| KV writes | 1,000 / day, 1 per second per key | ≈ 4 per notification + hourly setting renewals ≈ 250 / day |
| KV lists | 1,000 / day | safety list every 15 min (prod) / 60 min (test) + ~3 after each send ≈ 200 / day |
| KV deletes | 1,000 / day | ≈ 0 — queue items expire by themselves (expirationTtl) |

Over a limit, the free plan fails the operation (Worker: error 1027; KV: the operation errors) — notifications are
then delayed or dropped (and counted), not billed. Paid usage exists only on the Paid plan ($5/month minimum),
which must be chosen manually. Docs: https://developers.cloudflare.com/workers/platform/limits ·
https://developers.cloudflare.com/workers/platform/pricing/ · https://developers.cloudflare.com/kv/platform/limits

The worker also reads Firestore with the caller's own sign-in (their profile on each request; the family's
setting at most hourly; members list at most every 6 h). That counts against the Firebase **Spark** quota.

## How sending works
* `/send` and `/test` **never push**. They check the caller, the family's permission and the recipients, then
  write one queue item under its own key (`q:{env}:{family}:{time}-{random}`, expires after 2 h) and a hint.
* The cron (every minute) delivers: ≤ 3 devices per run for prod + test together (test ≤ 1), primary family first.
* Delays: usually 1–2 minutes; up to ~15 minutes in rare cases (a lost hint is covered by the safety listing).

### Concurrency, crashes and stale reads — what is guaranteed and what isn't
KV has **no locks and no conditional writes**, and reads may lag (~60 s in other locations). So:

| Situation | Result |
|---|---|
| Two `/send` at the same moment | separate keys → **no loss** |
| Crash / CPU limit in the middle of a run | chosen devices stay "in flight" → re-sent after 2 min → **possible duplicate, no loss** |
| Two cron runs overlapping | both may send the same devices → **possible duplicate (≤ 3), no loss** |
| Stale read of the cron state | **possible duplicate**; the same instance remembers its last write, which usually prevents it |
| Temporary push error (429 / 5xx / network) | retried by later runs, max 3 attempts → **possible duplicate** if the first one actually arrived |
| Worker or KV down > 30 min, retries exhausted, daily KV limit | **loss — always counted** in the run report |

Phones show notifications with `tag` = kind, so a duplicate replaces the earlier one (it may sound again).
Tested locally with a KV simulator (interleavings, a crash after every single operation, stale reads, hidden list
entries). **Not provable locally:** real KV timing, whether Cloudflare ever starts two runs for one minute, real phones.

## Readable notifications (owner's decision, 2026-10-09)
The owner chose notifications with content ("🛒 נוספו 3 פריטים לקניות · תהילה: חלב, ביצים, לחם") over generic ones,
and accepted that Cloudflare keeps that text for a short time:
* `/send` items carry `title`, `body`, `tag` (validated, cut to 80 / 180 chars). Queue items expire after **2 hours**.
* The cron state keeps a device's text only while it waits/retries — never more than 30 min after it was due.
* **Reminders** carry text too and stay in the family's plan (`jobs:{env}:{family}`) **until their time — up to 8 days**,
  replaced whenever the plan changes. Without text, the fixed generic text is used.
* Fridge notes stay generic (the app sends no text for them). Nothing with text is ever logged.

Grouping happens in the app (90 s after the last addition, ≤ 5 min, or when the app goes to the background) — one
`/send` per group, which also saves KV writes.

## New-version announcement
`POST /announce` with header `x-nido-key: <ANNOUNCE_KEY>` and `{ env, title, body, tag }` → queued for the active members
of every allowed family (test: home only), skipping anyone who turned "גרסה חדשה" off. Called by the deploy workflow
only when a push adds a note to `updates.json`. Setup: one random key (≥ 24 chars) saved as Cloudflare secret
`ANNOUNCE_KEY` **and** GitHub secret `NIDO_ANNOUNCE_KEY`. Without it the endpoint answers 503 and the workflow skips.

## Which families get notifications
Admin screen → **התראות**. The switch is `families/{fid}.push` in Firestore — only the system admin may write it
(existing rule `allow write: if boot()` on `families/{fid}`). A frozen family (`active: false`) gets nothing even with
the switch on. New families start **off**. The primary family is the family in the system admin's own Firestore
profile (no default — without it nothing is sent).

The worker can't read Firestore by itself (no service key, by design). It learns about changes when the admin's app
calls `/policy` (reads Firestore with his sign-in) or when a family member's app calls it (hourly). The screen shows:
"נשמר במסד הנתונים · ממתין לאימות השרת" until the server confirms, then "אומת בשרת". It never shows success first.
* **After confirmation:** applied by the next cron run that reads it — usually within 1–2 minutes (KV lag).
* **Without confirmation:** the old setting can keep working until the admin's app syncs (retried every minute while
  open), a member's hourly refresh, or its 48-hour expiry — **at most 48 hours.**
* The other side of 48 h: if nobody in the family (and not the admin) opens the app for 48 hours, the family's
  setting expires and its reminders stop until someone opens the app.

## CPU
`node push-worker/bench/cron-bench.mjs` — a LOCAL Node estimate only (median ≈ 1.5 ms for one phone, ≈ 3.5 ms for the
3-push cap; first run of a process ≈ 50 ms because of crypto start-up; occasional spikes ≈ 25 ms). Cloudflare runs a
different engine on different hardware; **compliance with the 10 ms limit is unknown until measured there.** If a run is
stopped for CPU, its devices are re-sent by the next runs (see the table) — a duplicate, not a loss.

## Setup (later, only with approval)
1. Owner creates a Cloudflare account (no card) and checks: plan = **Workers Free**, no payment method.
2. Keys: in the app, admin → התראות → "הגדרת שרת ההתראות" → **יצירת מפתחות** (made in the browser, never sent or saved).
   (Alternative on a computer: `node push-worker/gen-vapid.mjs`.) The private key goes ONLY into the Cloudflare secret
   `VAPID_PRIVATE` — never GitHub, the app, Firestore, chat or e-mail.
3. Create the worker, the KV namespace (bound as `NIDO`), the cron `* * * * *` and the two secrets — in the Cloudflare
   dashboard (or with `wrangler`). Then put the worker URL in `PUSH_URL` in `index.html`, release to **test** first,
   try on real phones, then prod. Then switch the primary family **on** in the admin screen (it has no `push` yet).

Until the VAPID secrets are set, the worker answers `503 not-configured` and sends nothing.

## Tests (local, mocks only)
* `node push-worker/test/worker.test.mjs` — worker: auth, isolation, queue, concurrency, crashes, stale reads,
  retries, budget, permissions, primary first.
* `node push-worker/test/ui.test.cjs` — admin screen states (needs Playwright + Chromium).
* **Not covered:** Firestore rules against the real rules engine (the emulator can't be downloaded here) — the rules
  are unchanged; only a text check exists. Real Cloudflare CPU, real KV timing, real phones.
