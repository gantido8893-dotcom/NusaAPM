# target-app

A small sample **Monitored_App** for the Personal AI-Powered APM System. It is the
instrumented target Prometheus scrapes (Requirement 1.1) and the source of the
`(load, latency)` data the empirical complexity engine fits against (Requirement 2.1).

## What it exposes

Metrics are served on `GET /metrics` in Prometheus text exposition format via the
official Prometheus Node client (`prom-client`, free/OSS — satisfies the $0 constraint).

| Metric | Type | Purpose |
|---|---|---|
| `http_request_duration_seconds` | histogram | request latency; buckets enable p50/p95/p99 via `histogram_quantile` |
| `http_requests_total` | counter | request throughput; feeds req/s via `rate()` |
| `http_request_errors_total` | counter | count of 5xx responses (error metric) |
| `process_*` (default metrics) | gauge/counter | runtime RSS/heap etc. for the memory/space signals |

All series carry `method`, `route`, and `status_code` labels (route is the pathname,
so query strings do not inflate label cardinality).

## Routes

| Route | Behaviour |
|---|---|
| `GET /metrics` | Prometheus scrape endpoint |
| `GET /` | liveness/info JSON |
| `GET /work?n=<int>` | simulates work whose latency grows ~linearly with `n` (clamped 0–500), so the complexity fitter sees varied, load-dependent latency |
| `GET /flaky` | returns 500 ~30% of the time to exercise the error counter |

## Run

```bash
npm install
npm run build
npm start          # listens on :3000 by default
```

Environment variables:

- `PORT` (default `3000`)
- `HOST` (default `0.0.0.0`)
- `SELF_LOAD` — set to `0` to disable the built-in traffic generator that periodically
  hits `/work` at varied load levels (enabled by default so metrics have live data).

## Note on the Prometheus client package

`prom-client` was renamed on npm to `@prometheus-io/client`; installing `prom-client`
prints a deprecation notice but the package is fully functional and remains the standard
Node Prometheus client. Both are the same free/OSS library. This project pins
`prom-client` as directed; switching to `@prometheus-io/client` is a drop-in rename if
the deprecation notice is undesirable.
