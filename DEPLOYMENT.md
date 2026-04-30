# Cockpit OS — Deployment Guide

This is the runbook for getting Cockpit OS running against a real
Firestore project, wired to an OpenClaw gateway, and reachable over the
internet. Every step here is reversible until you flip DNS and start
sending real traffic.

## TL;DR

```bash
# 1. Local dev (in-memory, no cloud)
export OPENCLAW_HOOKS_TOKEN=$(openssl rand -hex 32)
export COCKPIT_DRY_RUN=1
npm install
npm run build
npm run serve
# → http://127.0.0.1:8787/

# 2. Smoke test
curl -s http://127.0.0.1:8787/healthz
curl -s http://127.0.0.1:8787/api/dashboard/summary \
  -H "authorization: Bearer $OPENCLAW_HOOKS_TOKEN"
```

When that works, follow the production sections below.

---

## 1. Prerequisites

- Node.js **20+**, npm 10+.
- A Firebase / GCP project (anything with Firestore in Native mode).
- A service account with the `roles/datastore.user` role, or — easier —
  Firebase Admin SDK default credentials on whichever runtime you pick
  (Cloud Run, Cloud Functions, GKE, Fly.io, etc.).
- An OpenClaw gateway you control. (If you don't have one yet, run
  Cockpit in dry-run mode against `genericIntentMapping` first and add
  OpenClaw later — none of Cockpit's contracts depend on it.)
- A long random `OPENCLAW_HOOKS_TOKEN` shared between Cockpit and the
  gateway. 32 bytes hex is plenty:
  `openssl rand -hex 32`.

---

## 2. Environment variables

Cockpit OS is configured exclusively through env vars. There is no
`config.yaml` — every secret is named, every default is documented in
code, and every override is opt-in.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `OPENCLAW_HOOKS_TOKEN` | **yes** | _(refuses to start)_ | Bearer token for `/hooks/*`. Also serves as admin fallback if `COCKPIT_ADMIN_TOKEN` is unset. |
| `COCKPIT_ADMIN_TOKEN` | recommended | _(falls back to hooks token)_ | Separate bearer for `/api/*` (dashboard + identity admin). Set this in production for defence in depth. |
| `GOOGLE_APPLICATION_CREDENTIALS` | yes (prod) | — | Path to service-account JSON; alternatively use ADC. |
| `FIREBASE_PROJECT_ID` | yes (prod) | — | GCP project id for Firestore. |
| `COCKPIT_DRY_RUN` | no | unset | `1` forces in-memory shim; never read/write Firestore. |
| `COCKPIT_LOG_LEVEL` | no | `info` | `debug`/`info`/`warn`/`error`. |
| `COCKPIT_ALLOW_NO_TOKEN` | no | unset | `1` lets `cockpit-serve` boot without a token (local dev only — every write 401s). |
| `OPENCLAW_GATEWAY_BASE_URL` | no | `http://127.0.0.1:18789` | Where Cockpit POSTs outbound notifications. |
| `OPENCLAW_HOOKS_OUTBOUND_PATH` | no | `cockpit-notify` | Path suffix for outbound. |
| `PORT` | no | `8787` | Listening port for `cockpit-serve`. |
| `HOST` | no | `0.0.0.0` | Bind address. |
| `COCKPIT_RATELIMIT_DISABLED` | no | unset | `1` disables the in-process rate limiter (use when fronted by a platform limiter). |
| `COCKPIT_RATELIMIT_HOOKS_RPM` | no | `600` | Steady-state requests/minute per client for `/hooks/*`. |
| `COCKPIT_RATELIMIT_HOOKS_BURST` | no | `30` | Burst capacity for `/hooks/*`. |
| `COCKPIT_RATELIMIT_API_RPM` | no | `300` | Steady-state requests/minute per client for `/api/*`. |
| `COCKPIT_RATELIMIT_API_BURST` | no | `20` | Burst capacity for `/api/*`. |
| `COCKPIT_CSP` | no | _(strict default)_ | Override the Content-Security-Policy header. Default is `default-src 'self'` plus tight `script-src`/`style-src`/`frame-ancestors`. |

Cockpit refuses to start without `OPENCLAW_HOOKS_TOKEN` unless
`COCKPIT_ALLOW_NO_TOKEN=1` is also set. This is the single most common
deployment mistake; the refusal is intentional.

---

## 3. Pick a runtime

Cockpit ships three deployment shapes. Pick whichever matches your stack.

### 3a. Cloud Run (recommended)

Cloud Run gives you autoscaling, ADC, and HTTPS termination for free.

```bash
# from the cockpit-os directory
gcloud run deploy cockpit-os \
  --source=. \
  --platform=managed \
  --region=us-central1 \
  --allow-unauthenticated \
  --set-env-vars=FIREBASE_PROJECT_ID=YOUR_PROJECT \
  --set-secrets=OPENCLAW_HOOKS_TOKEN=cockpit-hooks-token:latest \
  --command="node" \
  --args="dist/bin/serve.js"
```

Notes:
- `--allow-unauthenticated` is fine because **every Cockpit endpoint
  bearer-checks the same token**. There's no "public surface" to
  protect at the platform layer.
- Store the token in Secret Manager, not plain env vars.
- Cloud Run sets `PORT` automatically; Cockpit picks it up.

### 3b. Firebase / Cloud Functions (gen 2)

Use `cloudFunctionsHandler` directly. Pull this into a tiny wrapper
project:

```ts
// functions/index.ts
import { onRequest } from 'firebase-functions/v2/https';
import { cloudFunctionsHandler, registerSeedMappings } from '@cockpit-os/core';

registerSeedMappings();

export const cockpit = onRequest(
  { region: 'us-central1', secrets: ['OPENCLAW_HOOKS_TOKEN'] },
  cloudFunctionsHandler,
);
```

The single `cockpit` function handles all routes — there's no need to
split `/hooks/*` and `/api/*` across functions.

### 3c. Plain Node (Fly.io, Render, Railway, EC2, your laptop)

```bash
npm install
npm run build
PORT=8787 \
OPENCLAW_HOOKS_TOKEN=... \
GOOGLE_APPLICATION_CREDENTIALS=/etc/sa.json \
FIREBASE_PROJECT_ID=your-project \
node dist/bin/serve.js
```

Wrap with systemd, pm2, or your platform's process manager. The server
handles SIGINT/SIGTERM cleanly.

---

## 4. Wiring OpenClaw

OpenClaw needs to know two things: where Cockpit lives, and the shared
token.

In OpenClaw's gateway config:

```jsonc
{
  "cockpit": {
    "baseUrl": "https://cockpit.example.com",
    "hooksToken": "<same OPENCLAW_HOOKS_TOKEN>"
  }
}
```

The seed mappings give you these inbound paths out of the box:

| Path | What it does |
|---|---|
| `POST /hooks/cockpit-imessage-inbound` | iMessage arrived |
| `POST /hooks/cockpit-telegram-inbound` | Telegram arrived |
| `POST /hooks/cockpit-slack-inbound` | Slack mention or DM |
| `POST /hooks/cockpit-task-due` | Task hit due date |
| `POST /hooks/cockpit-permission-granted` | OAuth grant landed |
| `POST /hooks/cockpit-intent` | Generic escape hatch (CLI / test) |

All of them require `Authorization: Bearer <token>` and a JSON body
with at least `body: {...}`. When the event has channel + handle
metadata, include `channel` and `handle` so Cockpit can resolve uid
from the identity registry.

---

## 5. Bootstrap users (identity binding)

Cockpit doesn't auto-create identities. Bind each user once after
their gateway-side auth flow completes:

```bash
curl -X POST https://cockpit.example.com/api/identities \
  -H "authorization: Bearer $OPENCLAW_HOOKS_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "channel": "imessage",
    "handle": "+15551234",
    "uid": "user_alice",
    "label": "Alice phone"
  }'
```

To revoke (e.g. user lost their phone):

```bash
curl -X POST https://cockpit.example.com/api/identities/revoke \
  -H "authorization: Bearer $OPENCLAW_HOOKS_TOKEN" \
  -H "content-type: application/json" \
  -d '{"channel":"imessage","handle":"+15551234"}'
```

Revoked bindings stay for forensics but never resolve.

**Security property**: an unknown or revoked handle never spawns a
job. The inbound handler returns 400 and writes a
`webhook.inbound.rejected` audit row instead.

---

## 6. Operate the dashboard

Visit `https://cockpit.example.com/` in a browser. Paste your
`OPENCLAW_HOOKS_TOKEN` into the field at the top right. The token is
remembered in `localStorage` so you only paste it once per browser.

What you see:

- **Pulse** — total events, first/last seen, kind/source counts
- **Job status** — live histogram from the `jobs` collection
- **By kind** / **By source** — bars over the audit log
- **Recent activity** — last 50 events, color-coded

Filter to a single user with the *uid* field. Auto-refresh runs every
30s while the tab is visible.

---

## 7. Firestore collections

Cockpit creates these collections lazily — no migration step.

| Collection | Written by | Schema source |
|---|---|---|
| `jobs` | `dispatcher/queue.ts` | `CockpitJobSchema` |
| `webhook_events` | `webhooks/inbound.ts` | _(internal idempotency)_ |
| `audit_events` | `audit/log.ts` | `AuditEventSchema` |
| `channelIdentities` | `identity/resolver.ts` | `ChannelIdentitySchema` |
| `notification_preferences` | `notifications/preferences.ts` | _(see file)_ |

### Recommended Firestore indexes

For Phase 1–6 traffic patterns, the only composite index you need is
on `jobs` (status, lockExpiresAt) so the worker claim query is fast:

```
jobs (status ASC, lockExpiresAt ASC)
```

The audit log queries used by the dashboard fall back to in-memory
filtering on the dry-run shim. In production, add these as your
volume grows:

```
audit_events (uid ASC, at DESC)
audit_events (kind ASC, at DESC)
audit_events (source ASC, at DESC)
```

---

## 8. Retention

Audit events are append-only. Set a TTL policy on `audit_events.at` if
you want automatic cleanup — Firestore TTL deletes are free:

```bash
gcloud firestore fields ttls update at \
  --collection-group=audit_events \
  --enable-ttl
```

Then add `at` as a Date field at write-time (Cockpit writes ISO
strings; convert in a tiny migration if you enable this).

For job records, retention is up to you. The dispatcher does not
delete completed jobs; an out-of-band sweeper is the recommended
pattern.

---

## 9. Health checks & alerting

- **Liveness**: `GET /healthz` returns 200 + JSON. No auth needed. Use this
  as the load-balancer healthcheck — it never touches Firestore so it
  won't flap on transient backend issues.
- **Readiness**: `GET /readyz` returns 200 only when the auth secret is
  configured; it returns 503 with `{ok:false, ready:false}` otherwise.
  Use this as the Kubernetes/Cloud Run startup probe so traffic only
  arrives after configuration is sane.
- **Request IDs**: every response carries `x-request-id` (echoed from the
  request if you set it, otherwise a fresh UUID). The same id is
  attached to every server-side log line for that request — grep on it
  to trace a problem end-to-end.
- **Rate limit signal**: the in-process limiter logs at `warn` with
  `msg="rate limit exceeded"`. Alert on any sustained rate.
- **Audit-driven alerts**: alert on bursts of
  `webhook.inbound.rejected`, `notification.failed`, or `job.failed`
  in the dashboard summary endpoint. They're the only kinds that
  indicate something is actually broken.

A starter Cloud Monitoring policy: query the audit collection for
`kind in (notification.failed, job.failed)` over a 5-minute window;
alert if count > 10.

---

## 10. Rolling forward

Cockpit ships dist-only — there's no migration runtime. To deploy a
new version:

1. `npm run build` against the new commit.
2. Re-deploy the runtime (Cloud Run revision, Functions deploy, etc.).
3. **Don't restart with mid-flight `awaiting_input` jobs unless you've
   verified the schema is still compatible.** Phase-by-phase the
   `CockpitJob` schema has been additive only, but a future breaking
   change would require you to drain awaiting jobs first.

Migrations, if needed, go in `src/migrations/` (not yet created;
add them under that path so they're discoverable).

---

## 11. Troubleshooting

**`cockpit-serve: refusing to start without OPENCLAW_HOOKS_TOKEN.`**
Set the env var. For pure local dev only,
`COCKPIT_ALLOW_NO_TOKEN=1` overrides — but every write returns 401.

**Every `/hooks/*` request returns 401.**
Token mismatch. The check is timing-safe and case-insensitive on the
scheme but case-sensitive on the token. Re-paste from your secret
store; verify both ends.

**Dashboard loads but every API call fails.**
Same thing — paste the token into the field at the top right.

**Inbound webhook returns 400 `identity unknown` even though the user
exists.**
You haven't bound the channel + handle yet. Bindings are explicit
(see section 5) — Cockpit refuses to guess.

**Computer callbacks return 400 `task id mismatch`.**
The callback's `taskId` doesn't match the parked job's
`externalTaskId`. Either you're delivering to the wrong job, or the
task-id propagation got dropped somewhere in the gateway. Check the
audit log — `computer.callback.rejected` rows include both ids in
their `data` field.

**Audit log is empty.**
Audit emit is best-effort and never throws. Check the process logs
for `audit emit failed` — that's the canary. Most often it's a
Firestore permission issue on the service account.

---

## 12. Security baseline

- **Two tokens.** `OPENCLAW_HOOKS_TOKEN` gates `/hooks/*` (the inbound
  webhook surface that OpenClaw posts to). `COCKPIT_ADMIN_TOKEN` gates
  `/api/*` (dashboard + identity admin). If `COCKPIT_ADMIN_TOKEN` is
  unset, admin routes fall back to the hooks token — set both for
  defence in depth so a compromised gateway secret doesn't unlock the
  admin surface. **Rotate both whenever a developer leaves.**
- **Bearer comparison is timing-safe** (constant-time `Buffer` compare).
- **Rate limiting on by default.** In-process token bucket per client IP
  (extracted from `x-forwarded-for`, falling back to `x-real-ip`,
  falling back to a single “anon” bucket). Defaults: 600 rpm / 30 burst
  on `/hooks/*`, 300 rpm / 20 burst on `/api/*`. Set
  `COCKPIT_RATELIMIT_DISABLED=1` if you front Cockpit with a platform
  limiter (Cloud Armor, AWS WAF, Cloudflare). Returns `429` with a
  `Retry-After` header when exceeded.
- **Body size cap** is 1 MB on the node:http adapter. Webhooks should
  be tiny; oversized requests are rejected before parsing.
- **Security headers** are applied to every response: `Content-Security-Policy`
  (strict, same-origin only), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Strict-Transport-Security` (HSTS, 1 year + subdomains). Override CSP
  via `COCKPIT_CSP` if you embed the dashboard cross-origin.
- **Error responses never leak stack traces.** Internal errors return
  `{ok:false, error:"internal error", requestId}`; the full detail
  goes to the structured log under that request id.
- **Audit log is append-only by convention** but Firestore allows
  overwrites; lock that down in security rules if you expose the
  database directly to anything else.
- **Dashboard UI is served unauthenticated; the API behind it is not.**
  That's the right shape for an SPA but it does mean the HTML is public.
  Don't put secrets in `dashboard.js`.

---

## 13. Going further

- **Phase 8 (not built)**: webhook signatures (HMAC of body + timestamp)
  in addition to bearer auth. Trivial add — the `checkInboundAuth`
  function is the only place to extend.
- **Phase 9 (not built)**: per-uid rate limits at the inbound handler.
  Ten lines using a Firestore counter.
- **Phase 10 (not built)**: a CLI for binding/listing identities and
  tailing the audit log. Wraps the same HTTP API the dashboard uses.

None of these block production usage. Cockpit OS as it stands is the
core platform; this list is the polish queue.
