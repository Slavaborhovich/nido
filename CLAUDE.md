# NIDO — iron rule: zero cost

**Nothing in this project may ever cost money — not even one agora. No exceptions.**

- Firebase stays on the **Spark (no-cost)** plan. Never upgrade to Blaze, never link a billing account, never add a payment method.
- No Cloud Functions, Cloud Storage (Firebase Storage), BigQuery, Pub/Sub, Cloud Monitoring/OAuth, or any Google Cloud API that needs billing.
- No paid SaaS, paid analytics, paid fonts, paid APIs, or trials that turn into payments.
- Hosting = GitHub Pages from a **public** repo (free). Keep the repo public — Pages from a private repo needs a paid GitHub plan.
- Images live inside Firestore (compressed), never in Storage.
- Push notifications (dormant code) may only ever use a **free** Cloudflare Workers plan with no payment method — otherwise they stay off.
- If any proposed change could create a charge: **stop and tell the user** instead of doing it.
- On Spark, exceeding a quota only blocks requests — it never bills. Keep it that way.
