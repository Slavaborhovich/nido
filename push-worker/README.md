# Nido push server (Cloudflare Worker) — NOT DEPLOYED

**Iron rule: 0 ₪.** Workers **Free** plan only. No credit card, no payment method, no Workers Paid,
no Durable Objects / Queues / D1 / R2. If Cloudflare ever asks for a card to continue — stop.

Everything below is a plan. Each step needs the owner's explicit approval before it is done.

## What it uses (all free)
| Resource | Free-plan limit (per Cloudflare docs) | Our use |
|---|---|---|
| Worker requests | 100,000 / day | app calls + 1,440 cron runs/day |
| CPU | 10 ms per invocation (HTTP and cron) | ≤ 3 devices per cron run (prod + test together, test ≤ 1), ≤ 2 right away per `/send` (the rest queued). **Not measured on Cloudflare yet** — local Node estimate ≈1.1–1.2 ms per push |
| Subrequests | 50 per invocation (every `fetch` **and** every KV call) | one budget of 30 per invocation (cron: shared by prod and test) |
| Cron Triggers | 5 per account | 1 (`* * * * *`) |
| KV reads | 100,000 / day | cron: ≈ 4 + 1 per listed family + 2 per allowed family, per minute (≈ 13k/day for one family) |
| KV writes / deletes | 1,000 / day each | capped per family and per user in code |
| KV storage | 1 GB | a few KB |

Over a limit, the free plan fails requests (Worker: error 1027; KV: the operation errors). Charges exist only on
the Paid plan ($5/month minimum), which must be chosen manually.
Docs: https://developers.cloudflare.com/workers/platform/limits · https://developers.cloudflare.com/workers/platform/pricing/

The worker also reads Firestore with the caller's own sign-in (1 read for the caller's profile on every request,
plus one family-members query when the roster is refreshed — at most every 6 h per family, or after an admin change).
Those count against the Firebase **Spark** quota (50,000 reads/day), which also never bills.

## Which families get notifications
Admin screen → **התראות** ("ניהול התראות למשפחות"). The switch is `families/{fid}.push` in Firestore — only the system
admin may write it (existing rule `allow write: if boot()` on `families/{fid}`). A frozen family (`active: false`) gets
nothing even with the switch on. New families start **off**. The primary family (the system admin's own) is served
first and can't be switched off from the screen. The worker reads the setting from Firestore itself; if it can't be
synced, the screen says so and retries when the admin's app opens. A missing or 8-day-old setting means "off".
After deployment the system admin must switch the primary family **on** once (it has no `push` field yet).

## Setup (later, only with approval)
1. Owner creates a Cloudflare account (no card) and checks: plan = **Workers Free**, no payment method.
2. Owner creates an API token limited to *Workers Scripts: Edit* + *Workers KV Storage: Edit* for that account.
3. Create the KV namespace: `wrangler kv namespace create NIDO` → put its id in `wrangler.toml`.
4. Keys (locally, nothing saved to disk):
   `node push-worker/gen-vapid.mjs`
   then `wrangler secret put VAPID_PUBLIC` and `wrangler secret put VAPID_PRIVATE` and paste each value.
   The private key exists only as a Cloudflare secret — never in GitHub, the app, Firestore, chat or logs.
5. `wrangler deploy` (from `push-worker/`).
6. Put the worker URL in `PUSH_URL` in `index.html`, release to **test** first, try on real phones, then prod.

Until VAPID secrets are set, the worker answers `503 not-configured` and sends nothing (no key is ever generated
at request time).

## Tests (local, mocks only)
`node push-worker/test/worker.test.mjs` — no network, no Cloudflare, no Firebase.
