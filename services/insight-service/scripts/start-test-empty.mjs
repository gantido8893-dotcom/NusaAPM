// start-test-empty.mjs — start the Insight_Service against a dead Prometheus.
//
// Cross-platform launcher used by `npm run start:test-empty`. It points
// PROMETHEUS_URL at a closed port so every per-item Prometheus query fails at
// the transport layer and the API returns explicit insufficient-data for each
// item (Requirement 9.4) while still responding HTTP 200 within the ≤2s budget
// (Requirement 9.5). No Prometheus and no LLM are contacted, so running the
// Postman collection against this instance is free (Requirement 13) and
// deterministic.
//
// Prereq: `npm run build` (this imports the compiled dist/index.js).

process.env.PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? "http://127.0.0.1:9";
process.env.PORT = process.env.PORT ?? "3001";
// Short timeout so an unreachable Prometheus fails fast, well within R9.5.
process.env.PROM_TIMEOUT_MS = process.env.PROM_TIMEOUT_MS ?? "500";

await import("../dist/index.js");
