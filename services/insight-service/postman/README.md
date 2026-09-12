# Insight_Service JSON API — API tests (task 5.13)

This folder holds a **version-controlled Postman collection** that tests every
endpoint of the Insight_Service JSON API defined in
[`src/api.ts`](../src/api.ts) (`createApp`).

- `insight-service.postman_collection.json` — the collection (Postman schema v2.1.0).
- `insight-service.local.postman_environment.json` — a local environment
  (`base_url = http://localhost:3001`).

## What it asserts

For each endpoint the collection asserts:

- **Correct response shape** — Requirements 9.1 (`/api/complexity`,
  `/api/complexity/:endpoint`), 9.2 (`/api/runway`), 9.3 (`/api/bands`), plus
  `/api/insight`, `/api/cost-notifications`, and the ack endpoint.
- **Explicit insufficient-data** — Requirement 9.4: an endpoint/metric with
  insufficient recorded data surfaces an explicit status
  (`insufficient-data` / `no-findings`) and the **whole request still returns
  HTTP 200**. One item's missing data never omits it silently and never fails
  the whole request. The unknown-endpoint request also proves a genuinely
  unknown endpoint returns explicit `insufficient-data` (200), not a 404/500.
- **≤2s response budget** — Requirement 9.5: a collection-level test asserts
  every response returns within `max_response_ms` (default 2000ms).

## Why a committed collection (and not the Postman cloud power)

Per `AGENTS.md` this project is **$0/month, single-user, no paid tier, no login
required**. The hosted Postman power needs an OAuth sign-in and stores
collections in the Postman cloud, and its `runCollection` executes in Postman's
cloud — which cannot reach a `localhost` API on your machine. To keep the
deliverable free, offline, deterministic, and re-runnable, the collection lives
in the repo and is run with **newman** (free, open source) or imported into the
Postman app manually. It can still be imported into the Postman power later if
desired; nothing here is Postman-account-specific.

## Running the tests (free, offline, deterministic)

The tests are designed to run against the service started with **no Prometheus
reachable**, so every per-item Prometheus query fails at the transport layer and
the API maps each failure to an explicit `insufficient-data` indicator while
still returning HTTP 200 — exactly the Requirement 9.4 behaviour. No Prometheus
and no LLM are contacted, so the run costs nothing (Requirement 13).

### Option A — vitest (no extra install)

The committed test `src/api.postman.test.ts` starts the app in-process against a
dead Prometheus and runs the same assertions the collection encodes:

```bash
npm test -- api.postman
```

### Option B — newman (matches how the .json collection runs in CI/Postman)

`newman` is a free OSS CLI. Install it on demand (it is not committed as a dep to
keep the install lean); the run itself is free:

```bash
# 1. Build and start the API against a dead Prometheus (every item -> insufficient-data)
npm run build
npm run start:test-empty        # PROMETHEUS_URL=http://127.0.0.1:9 PORT=3001

# 2. In another shell, run the collection with newman
npx newman run postman/insight-service.postman_collection.json \
  -e postman/insight-service.local.postman_environment.json
```

Or use the convenience script (also uses `npx newman`, no global install):

```bash
npm run test:api
```

### Importing into the Postman app

File → Import → select `insight-service.postman_collection.json` and
`insight-service.local.postman_environment.json`, then Run the collection with
the API listening on `localhost:3001`.
