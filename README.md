# Cockpit OS — Phases 1 + 2 + 3 + 4

Capability framework, MCP server, SKILL.md compiler, OpenClaw supervisor,
Firestore-backed dispatcher with local worker, bidirectional webhook bridge,
notification fabric, channel renderer, Cloud Functions trigger handlers,
**plus the real Perplexity Computer worker adapter with parked-job
callback flow and artifact pass-through**. This is the spine of the Cockpit
OS architecture: a single source of truth for everything Cockpit can do,
exposed simultaneously to OpenClaw (as skills + MCP tools) and to Perplexity
Computer (as MCP tools), with a typed job queue routing work between them,
a notification fabric delivering completion signals to whichever channel
the user prefers, and a clean two-way contract for offloading heavy work
to Computer.

## Architecture (recap)

```
cockpit-os/
└─ src/
    ├─ framework/     # defineCapability(), registry, Zod-typed contract
    ├─ context/       # Firebase Admin + dry-run shim + structured logger
    ├─ capabilities/  # the 4 starter capabilities
    ├─ mcp/server.ts  # stdio MCP server exposing the registry
    ├─ build/         # compile-skills.ts → SKILL.md generator
    ├─ dispatcher/    # job types, queue, router, intent registry, engine
    ├─ workers/       # local worker (capabilities) + computer adapter stub
    ├─ edge/          # OpenClaw supervisor + openclaw.json renderer
    ├─ webhooks/      # inbound (gateway → Cockpit) + outbound (Cockpit → gateway)
    ├─ notifications/ # channel renderer + preferences + fabric
    ├─ functions/     # Firestore trigger handlers (cloud topology)
    └─ computer/      # Computer dispatch client + callback handler
```

One definition per "thing Cockpit can do" produces:
- an MCP tool (for OpenClaw, Computer, etc.)
- a SKILL.md (for OpenClaw chat slash commands)
- a typed RPC handler (for the dispatcher)
- a routable intent (`cap:<id>`) the dispatcher can queue and run.

## What's in this drop

| Piece | Status |
|---|---|
| `defineCapability()` framework with Zod validation | Phase 1 — Done |
| Capability registry with duplicate-id protection | Phase 1 — Done |
| Firebase Admin context with safe in-memory dry-run | Phase 1 — Done |
| 4 example capabilities (`task-create`, `task-list`, `flight-log`, `note-append`) | Phase 1 — Done |
| MCP server exposing every capability over stdio | Phase 1 — Done |
| `compile-skills.ts` — SKILL.md generator from capabilities | Phase 1 — Done |
| OpenClaw supervisor (spawn, monitor, backoff, give-up) | **Phase 2 — Done** |
| `openclaw.json` renderer (skills, MCP, hooks) | **Phase 2 — Done** |
| Job types + Firestore-backed queue (with optimistic versioning) | **Phase 2 — Done** |
| Dispatcher router (capability/compound/budget/deadline rules) | **Phase 2 — Done** |
| Intent registry (capability vs compound, namespace separation) | **Phase 2 — Done** |
| Local worker (executes capabilities, classifies fatal failures) | **Phase 2 — Done** |
| Computer worker adapter | **Phase 4 — Stubbed** (clear seam, returns fatal stub error) |
| Engine: submit → enqueue → claim → run → done/failed with retry | **Phase 2 — Done** |
| Tests: framework, capabilities, compile-skills, MCP smoke, router, dispatcher, supervisor (33 tests) | **Phase 2 — Done** |
| Inbound webhook handler (token auth, replay dedup) | **Phase 3 — Done** |
| Outbound webhook dispatcher (retry/backoff, 4xx-fatal/5xx-retry) | **Phase 3 — Done** |
| Channel renderer (imessage, telegram, whatsapp, slack, discord, push, silent) | **Phase 3 — Done** |
| Notification fabric (preferences → channel routing → delivery) | **Phase 3 — Done** |
| Firestore trigger handlers (`onJobCreated` drives, `onJobUpdated` notifies) | **Phase 3 — Done** |
| `render-config` populates `hooks.mappings` from registered inbound mappings | **Phase 3 — Done** |
| Tests: render, preferences, outbound, fabric, inbound, triggers (35 new — 68 total) | **Phase 3 — Done** |
| Computer dispatch client (Zod-validated request/response, pluggable fetch, bearer auth) | **Phase 4 — Done** |
| Computer worker (parks job in `awaiting_input`, surfaces externalTaskId, fatal on 4xx) | **Phase 4 — Done** |
| `/hooks/computer-done` callback handler (Zod-validated, status + task-id correlation, retry budget honoured) | **Phase 4 — Done** |
| Engine support for `awaiting_input` (no auto-fail, no auto-retry, callback-driven resume) | **Phase 4 — Done** |
| Artifact pass-through (Computer artifacts → job.artifacts → notification links, Dropbox-ready) | **Phase 4 — Done** |
| Tests: computer client, worker, callback (19 new — 87 total) | **Phase 4 — Done** |

## Quick start

```bash
pnpm install            # or npm install
pnpm typecheck          # 0 errors expected
pnpm test               # 87/87 passing
pnpm compile-skills     # writes ./skills-out/cockpit-*/SKILL.md
pnpm mcp                # starts the stdio MCP server
```

By default everything runs in dry-run mode (no real Firestore writes). To wire
real Firebase, copy `.env.example` to `.env` and provide
`GOOGLE_APPLICATION_CREDENTIALS` (path to service-account JSON).

## Wiring it into OpenClaw

1. Install OpenClaw and run `openclaw onboard` once.

2. Tell OpenClaw about the Cockpit MCP server:

    ```bash
    openclaw mcp set cockpit \
      --command node \
      --args "$(pwd)/dist/mcp/server.js" \
      --env COCKPIT_UID=YOUR_UID \
      --env GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json
    ```

3. Generate skills directly into your OpenClaw workspace:

    ```bash
    COCKPIT_SKILLS_OUT="$HOME/.openclaw/workspace/skills" \
    pnpm compile-skills --clean
    ```

4. Restart your OpenClaw session. `openclaw skills list --eligible` should
   show all four `cockpit-*` skills, and `openclaw mcp` should list `cockpit`.

5. From any OpenClaw channel: *"add a task to ship cockpit-os v0.1"* →
   the LLM picks `cockpit-task-create`, calls the MCP tool, returns the new id.

## Defining a new capability

```ts
// src/capabilities/video-export-status.ts
import { z } from 'zod';
import { defineCapability, register } from '../framework/index.js';

export const videoExportStatus = register(
  defineCapability({
    id: 'video-export-status',
    description: 'Check the render/export status of a video project.',
    effect: 'read',
    tags: ['cockpit', 'video', 'content-pipeline'],
    input: z.object({
      projectId: z.string().min(1),
    }),
    handler: async ({ projectId }, ctx) => {
      const snap = await ctx.db.collection('videos').doc(projectId).get();
      if (!snap.exists) return { status: 'unknown', projectId };
      const data = snap.data() as { status: string; progress?: number };
      return { projectId, status: data.status, progress: data.progress ?? null };
    },
  }),
);
```

Then add it to `src/capabilities/index.ts`. That single file change updates
the MCP tool list, generates a `cockpit-video-export-status/SKILL.md`, and
makes it available to the in-process dispatcher.

## Phase 2: supervisor

The supervisor owns the OpenClaw gateway as a child process of Cockpit OS:
renders `openclaw.json`, spawns the gateway, restarts on crash with capped
exponential backoff, and gives up after `maxRestarts` to avoid pinning a CPU
on a permanently broken binary.

```ts
import {
  OpenClawSupervisor,
  renderOpenclawConfig,
} from '@cockpit-os/core/dist/edge/index.js';
import '@cockpit-os/core/dist/capabilities/index.js'; // register capabilities

const sup = new OpenClawSupervisor({
  binary: '/usr/local/bin/openclaw',
  args: ['gateway', '--port', '18789'],
  workspaceDir: `${process.env.HOME}/.openclaw/workspace`,
  configPath: `${process.env.HOME}/.openclaw/openclaw.json`,
  env: { COCKPIT_UID: process.env.COCKPIT_UID! },
  maxRestarts: 12,
});

const config = renderOpenclawConfig({
  workspaceDir: `${process.env.HOME}/.openclaw/workspace`,
  mcpServerPath: `${import.meta.dirname}/dist/mcp/server.js`,
  cockpitUid: process.env.COCKPIT_UID!,
  googleApplicationCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  hooksToken: process.env.OPENCLAW_HOOKS_TOKEN,
});
await sup.writeConfig(JSON.stringify(config, null, 2));
await sup.start();

// Inspect health from the dashboard / health endpoint:
sup.getState();    // { status: 'running', pid, startedAt } | { status: 'crashed', restartIn, ... } | ...
sup.history;       // every state transition since construction
```

The `Spawner` is pluggable so tests use a `FakeSpawner` and never touch
`node:child_process` — see `test/supervisor.test.ts` for the pattern.

## Phase 2: dispatcher

The dispatcher is the queue + router + engine that decides whether a job
runs locally (against the capability registry) or offloads to Computer.

```ts
import { submit, registerIntent } from '@cockpit-os/core/dist/dispatcher/index.js';
import '@cockpit-os/core/dist/capabilities/index.js';

// Capability intents — no registration needed, prefixed with 'cap:'.
await submit({
  uid: 'user-123',
  intent: 'cap:task-create',
  source: 'openclaw',
  payload: { title: 'review week\u2019s flights' },
});

// Compound intents — register once, route by preference.
registerIntent({
  id: 'flight-anomaly-report',
  description: 'Multi-source aviation anomaly writeup as a PDF.',
  preferredWorker: 'computer',
  requiredCapabilities: ['flight-log', 'note-append'],
});

await submit({
  uid: 'user-123',
  intent: 'flight-anomaly-report',
  source: 'openclaw',
  payload: { window: '7d' },
  deliver: { channel: 'imessage', to: '+15555550199' },
});
```

The router decides in this order:

1. **Explicit `worker` override** — used by tests and webhook ingress.
2. **Tight deadline (<30s)** — force local; round-trip to Computer would blow the budget.
3. **Capability intent (`cap:<id>`)** — always local.
4. **Compound intent** — use its `preferredWorker`.
5. **Token budget** — anything > 50k estimated tokens goes to Computer.
6. **Default** — local. Better to refuse cheaply than silently spend.

The **engine** drives jobs through `queued → claimed → running → done | failed`
with optimistic versioning to detect concurrent updates. Workers never
throw — they pack failures into `WorkerResult.error`, with `fatal: true`
to skip retries when a retry would be pointless (unknown capability, schema
validation, etc.). Non-fatal failures are requeued until `attempts >= maxAttempts`.

### In-process vs cloud topology

`submit()` accepts `{ drive: false }` so the same call works in two
topologies without changing call sites:

- **In-process** (today, dev): `submit()` enqueues *and* drives synchronously.
- **Cloud** (Phase 3): `submit({ drive: false })` only enqueues; a Firestore
  trigger on `jobs/{id}` calls `drive(jobId)` from a Cloud Function.

The local worker re-uses the same capability handlers the MCP server
exposes — `capabilityRegistry.get(capId)?.handler(payload, ctx)`. No
duplication, ever. The computer adapter is stubbed in `src/workers/computer.ts`
with a clean seam; Phase 4 fills it in to POST jobs to Computer with a
callback URL and respect `awaiting_input` until `/hooks/computer-done` fires.

## Design notes

- **Capabilities never trust their callers.** `defineCapability()` wraps every
  handler in a Zod parse so MCP, RPC, the dispatcher, and tests all see
  validated input. Removing this would let bad inputs reach Firestore.

- **Dry-run is the default for unknown environments.** The Firebase context
  falls back to an in-memory shim if no credentials are present. This means
  a fresh clone runs end-to-end without ever pointing at production.

- **MCP `inputSchema` is the contract.** The MCP server reads each
  capability's Zod object shape and advertises it as JSON Schema, so any
  conforming client (OpenClaw, Computer, Claude Desktop, Codex) gets typed
  inputs for free.

- **Logs go to stderr, not stdout.** The MCP transport reserves stdout for
  protocol frames. The structured logger writes only to stderr; if you
  ever see a non-JSON line in stdout, that's a bug.

- **`metadata` in SKILL.md is single-line JSON.** The OpenClaw frontmatter
  parser only accepts single-line frontmatter values. The compiler enforces
  this; the test suite verifies it.

## Testing

```bash
pnpm test
```

Sixteen test files, all in `test/`:

1. **`framework.test.ts`** — defineCapability + registry contract.
2. **`capabilities.test.ts`** — black-box handler tests in dry-run mode.
3. **`compile-skills.test.ts`** — every capability produces a valid SKILL.md.
4. **`mcp-smoke.test.ts`** — spawns the MCP server and speaks the protocol
    over stdio: initialize, tools/list, tools/call, validation failure.
5. **`router.test.ts`** — every routing rule and the precedence between them.
6. **`dispatcher.test.ts`** — end-to-end submit → drive across success, fatal
   failure, validation failure, computer-stub, and queue-only modes.
7. **`supervisor.test.ts`** — supervisor lifecycle with a FakeSpawner: start,
   crash + restart, give-up after maxRestarts, config rendering to disk.
8. **`render.test.ts`** — channel rendering (severity glyphs, telegram MD
   escaping, slack attachments, push title clamping).
9. **`preferences.test.ts`** — channel selection logic, severity filtering,
   UTC quiet-hours window with wraparound.
10. **`outbound.test.ts`** — first-attempt success, 5xx retry-then-succeed,
    4xx fatal, retry exhaustion.
11. **`fabric.test.ts`** — drop on no channels, deliver override, prefs
    lookup, 4xx failure, silent channel suppression.
12. **`inbound.test.ts`** — auth check (constant-time, no-token-closed),
    unknown mapping, malformed payload, mapping → job, replay dedup.
13. **`triggers.test.ts`** — `handleJobCreated` drives queued jobs and
    skips non-queued/invalid; `handleJobUpdated` notifies on terminal
    transitions exactly once; `jobToNotification` rendering.
14. **`computer-client.test.ts`** — dispatch client wire format (URL,
    bearer auth, JSON body), 4xx-fatal / 5xx-non-fatal classification,
    malformed-response handling.
15. **`computer-worker.test.ts`** — worker parks the job with
    `awaitingInput=true`, request shape (callbackUrl, capabilities,
    deadlineAt pass-through), fatal vs non-fatal dispatch failures.
16. **`computer-callback.test.ts`** — callback resume to done with
    artifacts, status=failed routes through markFailed, wrong-status
    rejection, double-delivery is a no-op, task-id mismatch refuses to
    mutate, unknown jobId / malformed payload errors.

All 87 tests pass on a clean clone.

## Phase 3: webhook bridge + notification fabric

Phase 3 closes the loop in both directions between Cockpit OS and the
OpenClaw gateway. Inbound: the gateway POSTs `/hooks/cockpit-*` events into
Cockpit, which authenticates them, deduplicates replays, and turns them
into jobs. Outbound: when a job finishes, the notification fabric picks the
right channel for the user, renders a channel-specific message, and POSTs
it to the matching `/hooks/cockpit-*` mapping for the gateway to deliver.

### Inbound webhooks

```ts
import {
  registerInbound,
  checkInboundAuth,
  handleInboundEvent,
} from '@cockpit-os/core/dist/webhooks/index.js';

registerInbound({
  id: 'imessage',                // → mapping path 'cockpit-imessage'
  source: 'imessage',
  toIntent: (payload) => ({
    intent: 'cap:task-create',
    payload: { title: String(payload.text ?? '').trim() },
  }),
});

// In your HTTP handler (Cloud Function, Cloud Run, etc.):
if (!checkInboundAuth(req.headers.authorization)) return res.status(401).end();
const out = await handleInboundEvent(ctx, {
  mappingId: 'imessage',
  eventId: req.headers['x-event-id'],   // optional, enables replay dedup
  payload: req.body,
});
// out: { jobId, deduped?: true }
```

Auth uses `OPENCLAW_HOOKS_TOKEN` (timing-safe Bearer compare; **closed by
default** when no token is configured). Replay dedup writes to Firestore
`webhook_events/{eventId}` and short-circuits subsequent deliveries to the
original `jobId`.

### Outbound webhooks

```ts
import { dispatchOutbound, nodeFetchClient } from '@cockpit-os/core/dist/webhooks/index.js';

await dispatchOutbound(
  delivery,                                  // OutboundDelivery (Zod-validated)
  { gatewayBaseUrl: 'http://127.0.0.1:18789', mappingPath: 'cockpit-notify' },
  nodeFetchClient,                           // pluggable for tests
);
```

4xx is fatal (no retry); 5xx and network errors retry with backoff
`[200, 800, 2000]ms` (default 3 attempts). The `OutboundClient` interface
is swappable so tests never hit the network.

### Channel renderer

`renderForChannel(notification, channel)` produces a channel-shaped
payload for `imessage`, `telegram`, `whatsapp`, `slack`, `discord`, `push`,
or `silent`. Severity glyphs, Telegram MarkdownV2 escaping, Slack
attachments, and push title clamping are handled centrally so capabilities
never know about delivery formats.

### Notification fabric

```ts
import { notify } from '@cockpit-os/core/dist/notifications/index.js';

await notify(ctx, {
  uid: 'user-123',
  severity: 'success',
  title: 'Flight log saved',
  body: 'N123AB · 1.2h',
  artifacts: [{ kind: 'pdf', url: 'https://…' }],
});
```

`notify()` reads the user's preferences (stored at `users/{uid}/prefs/notifications`),
picks a channel based on severity + UTC quiet-hours (only `severity >=
warning` bypasses quiet-hours; wraparound windows like `22:00-06:00` are
handled), renders, and dispatches. Pass `{ deliver }` on the original job
to override the user's preference for a single job.

### Firestore triggers (cloud topology)

```ts
import { handleJobCreated, handleJobUpdated } from '@cockpit-os/core/dist/functions/index.js';

// onWrite(jobs/{jobId})
export const onJobCreated = functions.firestore.document('jobs/{jobId}')
  .onCreate((snap) => handleJobCreated(ctx, snap));

export const onJobUpdated = functions.firestore.document('jobs/{jobId}')
  .onUpdate((change) => handleJobUpdated(ctx, change.before, change.after));
```

`handleJobCreated` drives queued jobs through the engine — exactly the
seam `submit({ drive: false })` was designed for. `handleJobUpdated` fires
`notify()` on terminal transitions (`done`, `failed`) **exactly once** by
guarding against `prev` already being terminal, so re-deliveries from
Firestore don't double-notify.

### `render-config` integration

`renderOpenclawConfig()` now populates `hooks.mappings` from the inbound
registry: every `registerInbound({ id })` produces a mapping at path
`cockpit-${id}` with `action: 'agent'`. Add a new inbound source by
importing and registering it before calling `renderOpenclawConfig()` —
the gateway will pick it up on the next supervisor restart.

## Phase 4: Computer worker adapter

Phase 4 turns the seam in `src/workers/computer.ts` into a real adapter.
Heavy-lift jobs (compound intents whose `preferredWorker: 'computer'` was
set, or anything the router pushes there based on token budget) now flow
from Cockpit OS to Computer and back, end to end.

### The handoff in 5 steps

```
  1. submit({worker:'computer'})
         → router selects 'computer', enqueues the job

  2. computerWorker.run(job, ctx)
         → builds a ComputerTaskRequest (taskId, callbackUrl, capabilities)
         → ComputerClient.submit() POSTs to the dispatch endpoint
         → returns { ok: true, awaitingInput: true, externalTaskId }

  3. engine sees awaitingInput=true
         → markAwaitingInput(job, externalTaskId)  (no done, no failed, no retry)

  4. Computer eventually finishes the work
         → POSTs ComputerCallbackPayload to /hooks/computer-done on the gateway
         → gateway authenticates with OPENCLAW_HOOKS_TOKEN, forwards to Cockpit

  5. handleComputerCallback(ctx, payload)
         → schema check → status check (must be awaiting_input) → task-id match
         → markDone(artifacts) | markFailed(error, fatal?)  (honours retry budget)
         → notify(ctx, jobToNotification(final))  on terminal status
```

The key invariant: when a worker returns `awaitingInput=true`, the engine
parks the job in `awaiting_input` instead of marking it done or failed.
The engine still consumed one attempt at claim time, so a Computer task
that ultimately fails through the callback path won't get more retries
than the user budgeted. The callback's `markFailed` honours the same
retry budget every other failure path uses.

### Submission contract

```ts
import { computerWorker, setComputerWorkerClientForTesting } from '@cockpit-os/core/dist/workers/index.js';
import { createNodeFetchComputerClient } from '@cockpit-os/core/dist/computer/index.js';

// Production wiring (default endpoint = COMPUTER_DISPATCH_URL):
const client = createNodeFetchComputerClient({
  endpoint: process.env.COMPUTER_DISPATCH_URL!,
  token: process.env.COMPUTER_API_TOKEN,
});
setComputerWorkerClientForTesting(client); // also the production injection point
```

The worker builds a `ComputerTaskRequest` from the parked job:

```jsonc
{
  "taskId":      "ct_<jobId>_<rand>",
  "jobId":       "job_…",
  "uid":         "user-123",
  "intent":      "flight-anomaly-report",
  "payload":     { "window": "7d" },
  "capabilities": ["flight-log", "note-append"],
  "callbackUrl": "http://gw.local/hooks/computer-done",
  "deadlineAt":  "2026-12-31T23:59:00Z"   // optional, from job.context.deadlineAt
}
```

`callbackUrl` points at the OpenClaw gateway, not Cockpit OS directly —
the gateway owns public ingress, applies the shared
`OPENCLAW_HOOKS_TOKEN` auth, and forwards the body to Cockpit. From
Cockpit's perspective, this is just another inbound webhook.

### Callback handler

```ts
import { handleComputerCallback } from '@cockpit-os/core/dist/computer/index.js';

// In your HTTP handler (Cloud Function, Cloud Run, etc.):
//   - Auth check uses the same checkInboundAuth() Phase 3 ships.
//   - On 200, hand the JSON body to handleComputerCallback().
const result = await handleComputerCallback(ctx, req.body);
// { ok: true, jobId, finalStatus: 'done' | 'failed' }
```

The handler enforces three guards in order:

1. **Schema** — `ComputerCallbackPayloadSchema.parse()`. A malformed
   delivery returns `ok:false` with a clear error and never touches the job.
2. **Status** — the job must be in `awaiting_input`. If it's already
   terminal, the second delivery is a no-op success (idempotent). Any
   other status is rejected.
3. **Task id** — the parked job's `externalTaskId` must match the
   payload's `taskId`. A mismatch refuses to mutate the job.

On `status=done`, artifacts are appended to `job.artifacts` and the
notification fabric fires. On `status=failed`, the same `markFailed`
that handles local-worker failures runs, so a non-fatal Computer failure
with remaining attempts will re-queue and try again — even potentially
routing back to local on the next attempt if the router decides to.

### Artifact delivery

Computer's `JobArtifact` shape is identical to Cockpit's `JobArtifactSchema`,
so artifacts pass through verbatim. The Phase 3 channel renderer already
formats them as links per channel (Slack attachments, iMessage URL list,
etc.), and the planned Dropbox integration plugs in at the Computer side
by returning Dropbox-hosted URLs in the artifact list — no Cockpit-side
changes needed when that lands.

### Test injection

- `setComputerWorkerClientForTesting(fakeClient)` — swaps the dispatch
  client used by `computerWorker.run()`. Tests use this to assert the
  outbound request shape and to simulate sync responses.
- `createNodeFetchComputerClient({ fetchImpl })` — the production client
  accepts an explicit `fetch` for tests that want to assert wire format
  (URL, headers, body) without touching the network.

## Phase 5 — Identity, audit, observability

Phase 5 closes the loop between "a thing happened on a channel" and "who
in Cockpit owns that", and gives operators a way to read the system's
history without grepping logs.

### Identity resolver (`src/identity/`)

OpenClaw knows the user as a *channel handle* (a phone number on iMessage,
a chat id on Telegram, a workspace member id on Slack). Cockpit knows the
user as `uid`. The identity registry maps one to the other.

- `bindIdentity(ctx, { channel, handle, uid, label? })` — idempotent.
  Re-binding the same `(channel, handle)` to a new uid replaces the
  binding but **preserves `createdAt`** so the audit trail stays honest.
- `revokeIdentity(ctx, channel, handle)` — soft revoke. The row stays
  for forensics; subsequent `resolveIdentity()` calls return
  `{ uid: null, reason: 'revoked' }`.
- `resolveIdentity(ctx, { channel, handle })` — returns
  `{ uid: '…', identity }` on a live binding, or
  `{ uid: null, reason: 'unknown' | 'revoked' }` otherwise.
  **Never silently falls back to a default uid** — that is the entire
  security property of this layer.
- `listIdentitiesForUid(ctx, uid)` — dashboard helper.

Document id format: `${channel}:${handle}`, stored in
`channelIdentities/`. The supported channel set is
`imessage | telegram | whatsapp | slack | discord | email | push`.

The inbound webhook handler now runs the resolver before dispatching:
if the event carries `channel` + `handle` metadata, the resolved uid
**takes precedence** over the gateway-claimed uid and any uid the
mapping returned. Unknown or revoked handles are rejected with an
audit row — they never spawn jobs.

### Audit log (`src/audit/`)

Append-only collection of structured events. Every state change of
interest writes one row: webhook ingress, identity changes, job
lifecycle, computer callbacks, notification deliveries.

- `emitAuditEvent(ctx, { kind, uid, source, ref?, data? })` —
  best-effort. Emit **never throws**; a broken audit pipe must not
  break a job. Failures log at error level and the call returns the
  un-persisted event.
- `queryEvents(ctx, { uid?, kind?, source?, since?, until?, limit? })` —
  filtered read, newest-first.
- `recentEvents(ctx, limit?)` — last N across all uids.

The event-kind enum is closed (16 kinds) so emitters can't drift.
`source` is one of `webhook | engine | queue | fabric | computer |
identity`. The doc-id format `aev_${ms-padded-13}_${rand}` keeps the
dry-run shim approximately chronological.

Phase 5 wires emitters into:
- `dispatcher/queue.ts` — enqueued, claimed, awaiting, done, failed,
  requeued (running and cancelled are intentionally not emitted).
- `webhooks/inbound.ts` — received, rejected (with `reason`), deduped.
- `computer/callback.ts` — received, rejected (with `reason`).
- `notifications/fabric.ts` — delivered, dropped, failed.
- `identity/resolver.ts` — bound, revoked.

### Observability dashboard (`src/observability/`)

Read-only views over the audit log + jobs collection.

- `dashboardSummary(ctx, { uid?, since?, until?, scanLimit? })` —
  total event count, counts by kind (sorted desc), counts by source
  (sorted desc), first/last event timestamps in the window.
- `recentForUid(ctx, uid, limit?)` — per-user activity feed.
- `recentSystemActivity(ctx, limit?)` — the firehose.
- `jobStatusHistogram(ctx, uid?)` — buckets jobs by current status,
  read directly from `jobs/` because status is *now*, not history.

Everything is exported via the public barrel:

```ts
import { identity, audit, observability } from '@cockpit-os/core';

await identity.bindIdentity(ctx, { channel: 'imessage', handle: '+15551234', uid: 'u_alice' });
await audit.emitAuditEvent(ctx, { kind: 'job.enqueued', uid: 'u_alice', source: 'queue' });
const summary = await observability.dashboardSummary(ctx, { uid: 'u_alice' });
```

## Phase 6 — HTTP transport + seed mappings

Cockpit OS now binds to HTTP. The router is framework-agnostic; adapters
translate between framework-specific request/response shapes and the pure
`CockpitHttpRequest` / `CockpitHttpResponse` types.

### Routes

```
GET  /                          → dashboard UI (Phase 7)
GET  /healthz                   → liveness probe (no auth)
GET  /readyz                    → readiness probe (no auth, 503 if misconfigured)
GET  /dashboard.css             → dashboard stylesheet
GET  /dashboard.js              → dashboard client script

POST /hooks/cockpit-:mappingId  → inbound webhook (auth + dispatch)
POST /hooks/computer-done       → Computer task callback

GET  /api/dashboard/summary     → audit-log counters
GET  /api/dashboard/recent      → recent activity feed
GET  /api/dashboard/jobs        → job-status histogram
GET  /api/dashboard/identities  → list identities for a uid (?uid=)
POST /api/identities            → admin: bind identity
POST /api/identities/revoke     → admin: revoke identity
```

`/hooks/*` is gated with `OPENCLAW_HOOKS_TOKEN`. `/api/*` is gated with
`COCKPIT_ADMIN_TOKEN` (falls back to the hooks token if unset). Both
comparisons are timing-safe. The dashboard HTML is intentionally public;
the API behind it is not.

Every response carries `x-request-id` (echoed from the request or freshly
minted) and a strict set of security headers (`Content-Security-Policy`,
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, HSTS).

Production hardening built in:

- **Rate limiting** — token-bucket per client IP, defaults 600 rpm / 30
  burst on `/hooks/*`, 300 rpm / 20 burst on `/api/*`. Returns `429`
  with `Retry-After`. Disable with `COCKPIT_RATELIMIT_DISABLED=1` if
  you front Cockpit with Cloud Armor / WAF / Cloudflare.
- **1 MB body cap** on the node:http adapter.
- **Errors never leak stack traces** — internal failures return
  `{ok:false, error:"internal error", requestId}`; the full detail is
  logged under that request id.
- **Graceful shutdown** — `cockpit-serve` handles `SIGTERM`/`SIGINT`
  by closing the listener before exiting.

### Adapters

- **`createNodeListener()`** / **`startCockpitServer({ port, host })`** —
  plain `node:http`, no framework dependency. Powers `cockpit-serve`.
- **`cloudFunctionsHandler(req, res)`** — Express-compatible signature.
  Works under Express, Firebase Functions, and Google Cloud Functions
  (gen 2 with the functions framework).

All adapters share the same pure `routeRequest()` core, which means the
router test suite covers every adapter implicitly.

### `cockpit-serve` (local dev server)

```bash
export OPENCLAW_HOOKS_TOKEN=$(openssl rand -hex 32)
export COCKPIT_DRY_RUN=1
npm run serve
# → http://127.0.0.1:8787/
```

The server refuses to boot without `OPENCLAW_HOOKS_TOKEN` unless
`COCKPIT_ALLOW_NO_TOKEN=1` is also set (every write 401s in that mode).

### Seed mappings (`src/webhooks/seed-mappings.ts`)

Six inbound mappings ship registered out of the box via
`registerSeedMappings()`:

| Path | Intent | Body |
|---|---|---|
| `cockpit-imessage-inbound` | `chat.message.received` | `{ text, attachments? }` |
| `cockpit-telegram-inbound` | `chat.message.received` | `{ text }` |
| `cockpit-slack-inbound` | `chat.message.received` | `{ text, threadTs? }` |
| `cockpit-task-due` | `task.due` | `{ taskId, title, dueAt }` |
| `cockpit-permission-granted` | `permission.granted` | `{ scope, provider }` |
| `cockpit-intent` | _generic forwarder_ | `{ intent, payload?, deliver? }` |

`registerSeedMappings()` is idempotent across calls so a process can
boot it multiple times.

## Phase 7 — Dashboard UI

A single-page operator dashboard at `/`. No bundler, no framework —
three files (`index.html`, `dashboard.css`, `dashboard.js`) served as
static assets out of `dist/http/ui/`.

What it shows:

- **Pulse**: total events, first/last seen, kind/source counts.
- **Job status**: live histogram from the `jobs` collection.
- **By kind / By source**: bar charts over the audit log.
- **Recent activity**: last 50 events, color-coded by kind
  (failed/rejected red, done/delivered green, awaiting/dropped amber).

The operator pastes their `OPENCLAW_HOOKS_TOKEN` into the top-right
field once; it's remembered in `localStorage` for the session. The
dashboard auto-refreshes every 30s while the tab is visible. Filter
the whole view to a single user with the *uid* field.

## Roadmap

- **Phase 1 — Done** — capability framework, MCP server, SKILL.md compiler.
- **Phase 2 — Done** — supervisor, dispatcher (queue + router + engine),
  local worker, computer adapter seam.
- **Phase 3 — Done** — bidirectional webhook bridge, notification fabric,
  channel renderer, Firestore trigger handlers, render-config integration.
- **Phase 4 — Done** — Computer worker adapter, parked-job callback flow,
  artifact pass-through, Zod-typed dispatch contract.
- **Phase 5 — Done** — channel-identity resolver, append-only audit log,
  observability dashboard data layer. Inbound webhook now resolves uid
  from channel metadata; queue / inbound / callback / fabric / identity
  all emit audit events.
- **Phase 6 — Done** — HTTP transport (pure router + node:http and
  Cloud Functions adapters), `cockpit-serve` dev server, six seed
  inbound mappings, deployment runbook (`DEPLOYMENT.md`).
- **Phase 7 — Done** — single-page operator dashboard at `/` reading
  the observability layer; no bundler, no framework, three static files.

Each phase ships its own typed module and tests, and never breaks earlier
phases — the capability registry is the stable seam.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the production deployment
runbook (Cloud Run, Firebase Functions, plain Node), env-var reference,
Firestore index recommendations, and operational checklist.
