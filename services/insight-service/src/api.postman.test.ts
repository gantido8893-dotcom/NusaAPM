// Feature: personal-ai-apm-system — Task 5.13
// API tests for the Insight_Service JSON API (createApp in api.ts).
//
// These are the executable counterpart of the committed Postman collection at
// postman/insight-service.postman_collection.json: they assert the same three
// things the collection's test scripts assert, so the collection is verified to
// actually hold rather than merely authored.
//
//   - Correct response shape (Requirements 9.1, 9.2, 9.3).
//   - Explicit insufficient-data indicators, never a silently-omitted item and
//     never a whole-request failure (Requirement 9.4).
//   - The ≤2s response budget (Requirement 9.5).
//
// The app is started in-process against a mock PromClient that always throws
// PromTransportError — i.e. Prometheus is unreachable, exactly the free/
// deterministic mode the collection documents ("start the API with no
// Prometheus reachable"). No Prometheus and no LLM are contacted, so the run is
// free (Requirement 13) and deterministic. Requests go over real HTTP against
// app.listen so response time (R9.5) is measured end to end.
//
// Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp, type ApiTargets } from "./api.js";
import { PromTransportError, type PromClient } from "./promql.js";
import { ThresholdStore } from "./thresholds.js";

// A PromClient standing in for an unreachable Prometheus: every query fails at
// the transport layer, which is what the API maps to per-item insufficient-data
// (Requirement 9.4). This is the deterministic, cost-free stand-in for the
// documented "no Prometheus reachable" run mode.
const unreachableProm: PromClient = {
  instant: () =>
    Promise.reject(new PromTransportError("Prometheus unreachable (test)")),
  range: () =>
    Promise.reject(new PromTransportError("Prometheus unreachable (test)")),
  targetsUp: () =>
    Promise.reject(new PromTransportError("Prometheus unreachable (test)")),
};

const targets: ApiTargets = {
  endpoints: [{ endpoint: "target-app" }],
  metrics: [
    {
      metric: "process_resident_memory_bytes",
      query: "process_resident_memory_bytes",
      historyQuery: "process_resident_memory_bytes",
      redBandStart: 1_000_000_000,
    },
  ],
};

const MAX_RESPONSE_MS = 2000;
const VALID_COMPLEXITY_STATUS = ["ok", "insufficient-data", "indeterminate"];
const VALID_RUNWAY_STATUS = ["ok", "not-trending", "insufficient-data"];
const VALID_BANDS = ["green", "yellow", "red", "unknown"];
const VALID_INSIGHT_STATUS = [
  "ok",
  "skipped-rate-limit",
  "skipped-free-tier-limit",
  "no-findings",
];

let server: Server;
let baseUrl: string;

/** Fetch JSON and measure end-to-end response time (for the R9.5 budget). */
async function get(path: string): Promise<{
  status: number;
  body: any;
  elapsedMs: number;
}> {
  const started = Date.now();
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: "application/json" },
  });
  const body = await res.json();
  return { status: res.status, body, elapsedMs: Date.now() - started };
}

async function post(path: string): Promise<{
  status: number;
  body: any;
  elapsedMs: number;
}> {
  const started = Date.now();
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  const body = await res.json();
  return { status: res.status, body, elapsedMs: Date.now() - started };
}

beforeAll(async () => {
  const app = createApp(
    {
      prom: unreachableProm,
      thresholds: new ThresholdStore(),
      targets,
    },
    // Disable caching so every request genuinely re-computes; this proves the
    // ≤2s budget holds on a cold path, not just from a warm cache.
    { cacheTtlMs: 0 },
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /api/complexity (all endpoints)", () => {
  it("R9.1/R9.4/R9.5: shape, explicit per-endpoint status, ≤2s, 200", async () => {
    const { status, body, elapsedMs } = await get("/api/complexity");

    expect(status, "R9.4 whole request succeeds").toBe(200);
    expect(elapsedMs, "R9.5 ≤2s").toBeLessThanOrEqual(MAX_RESPONSE_MS);

    expect(Array.isArray(body.endpoints)).toBe(true);
    expect(body.endpoints.length, "at least one endpoint").toBeGreaterThan(0);

    for (const ep of body.endpoints) {
      expect(typeof ep.endpoint).toBe("string");
      expect(VALID_COMPLEXITY_STATUS).toContain(ep.time.status);
      expect(VALID_COMPLEXITY_STATUS).toContain(ep.space.status);
      expect(typeof ep.time.distinctLoadLevels).toBe("number");
      expect(typeof ep.space.distinctLoadLevels).toBe("number");
    }

    // Unreachable Prometheus => every item explicitly insufficient-data,
    // never omitted (Requirement 9.4).
    for (const ep of body.endpoints) {
      expect(ep.time.status, "R9.4 explicit insufficient-data").toBe(
        "insufficient-data",
      );
      expect(ep.space.status, "R9.4 explicit insufficient-data").toBe(
        "insufficient-data",
      );
    }
  });
});

describe("GET /api/complexity/:endpoint", () => {
  it("R9.1/R9.4: known endpoint returns explicit status, 200", async () => {
    const { status, body, elapsedMs } = await get("/api/complexity/target-app");
    expect(status).toBe(200);
    expect(elapsedMs).toBeLessThanOrEqual(MAX_RESPONSE_MS);
    expect(body.endpoint).toBe("target-app");
    expect(VALID_COMPLEXITY_STATUS).toContain(body.time.status);
    expect(VALID_COMPLEXITY_STATUS).toContain(body.space.status);
  });

  it("R9.4: unknown endpoint returns explicit insufficient-data (200, not 404/500)", async () => {
    const { status, body } = await get("/api/complexity/does-not-exist");
    expect(status).toBe(200);
    expect(body.endpoint).toBe("does-not-exist");
    expect(body.time.status).toBe("insufficient-data");
    expect(body.space.status).toBe("insufficient-data");
  });
});

describe("GET /api/runway", () => {
  it("R9.2/R9.4/R9.5: shape, explicit per-metric status, ≤2s, 200", async () => {
    const { status, body, elapsedMs } = await get("/api/runway");
    expect(status, "R9.4 whole request succeeds").toBe(200);
    expect(elapsedMs, "R9.5 ≤2s").toBeLessThanOrEqual(MAX_RESPONSE_MS);

    expect(Array.isArray(body.metrics)).toBe(true);
    expect(body.metrics.length).toBeGreaterThan(0);
    for (const m of body.metrics) {
      expect(typeof m.metric).toBe("string");
      expect(VALID_RUNWAY_STATUS).toContain(m.runway.status);
      expect(typeof m.runway.dataPoints).toBe("number");
    }
    // Unreachable history => explicit insufficient-data, not omitted.
    for (const m of body.metrics) {
      expect(m.runway.status).toBe("insufficient-data");
    }
  });
});

describe("GET /api/bands", () => {
  it("R9.3/R9.4/R9.5: shape, explicit band per metric, ≤2s, 200", async () => {
    const { status, body, elapsedMs } = await get("/api/bands");
    expect(status).toBe(200);
    expect(elapsedMs).toBeLessThanOrEqual(MAX_RESPONSE_MS);

    expect(Array.isArray(body.metrics)).toBe(true);
    expect(body.metrics.length).toBeGreaterThan(0);
    for (const m of body.metrics) {
      expect(typeof m.metric).toBe("string");
      expect(VALID_BANDS).toContain(m.band);
      if (Object.prototype.hasOwnProperty.call(m, "percentOfCritical")) {
        expect(typeof m.percentOfCritical).toBe("number");
      }
    }
    // No configured thresholds + unreachable value => explicit unknown band,
    // never a dropped metric (Requirement 9.4).
    for (const m of body.metrics) {
      expect(m.band).toBe("unknown");
    }
  });
});

describe("GET /api/insight", () => {
  it("returns a well-formed AiExplanation with explicit no-findings status", async () => {
    const { status, body, elapsedMs } = await get("/api/insight");
    expect(status).toBe(200);
    expect(elapsedMs).toBeLessThanOrEqual(MAX_RESPONSE_MS);
    expect(VALID_INSIGHT_STATUS).toContain(body.insight.status);
    expect(typeof body.insight.generatedAtMs).toBe("number");
    // Default path: explicit no-findings, never a fabricated hypothesis.
    expect(body.insight.status).toBe("no-findings");
  });
});

describe("GET /api/cost-notifications", () => {
  it("returns an empty notifications array by default", async () => {
    const { status, body, elapsedMs } = await get("/api/cost-notifications");
    expect(status).toBe(200);
    expect(elapsedMs).toBeLessThanOrEqual(MAX_RESPONSE_MS);
    expect(Array.isArray(body.notifications)).toBe(true);
    expect(body.notifications.length).toBe(0);
  });
});

describe("POST /api/cost-notifications/:id/ack", () => {
  it("R13.3: unknown id returns 404 with { acknowledged: false, id }", async () => {
    const { status, body, elapsedMs } = await post(
      "/api/cost-notifications/does-not-exist/ack",
    );
    expect(status).toBe(404);
    expect(elapsedMs).toBeLessThanOrEqual(MAX_RESPONSE_MS);
    expect(body.acknowledged).toBe(false);
    expect(body.id).toBe("does-not-exist");
  });
});
