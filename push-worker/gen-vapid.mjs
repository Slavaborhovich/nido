// Generates a VAPID key pair for the Nido push server — run LOCALLY, once, only when setting up.
//   node push-worker/gen-vapid.mjs
// It prints the two values; nothing is written to disk. Paste them straight into `wrangler secret put`.
// NEVER commit the private value, paste it in chat, Firestore, the app, or any file in this repo.
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
const b64u = b => Buffer.from(b).toString("base64url");
console.log("VAPID_PUBLIC  =", b64u(raw));
console.log("VAPID_PRIVATE =", jwk.d);
console.log("\nKeep the private value secret. Use it only with: wrangler secret put VAPID_PRIVATE");
