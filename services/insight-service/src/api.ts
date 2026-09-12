// api.ts — Insight_Service JSON API (task 5.12).
//
// Wires the pure-logic modules (promql, thresholds, complexity, forecast) into
// an Express HTTP server exposing the single-user JSON API described in
// design.md ("JSON API Design (Insight_Service)"):
//
//   GET  /api/complexity                    Time + space ComplexityEstimate per endpoint
//   GET  /api/complexity/:endpoint          Single endpoint's time + space estimate
//   GET  /api/runway                        RunwayEstimate per tracked metric
//   GET  /api/bands                         Current Band classification per metric
//   GET  /api/insight                       Latest AiExplanation + its evidence
//   GET  /api/cost-notifications            Active (unacknowledged) CostNotification[]
//   POST /api/cost-notifications/:id/ack    Acknowledge a notification by id
//
// Design invariants honoured here:
//   - Single-user, unauthenticated (Requirement 14.1, 14.2): no auth middleware,
//     no tenant selection, no billing surface.
//   - Explicit insufficient-data indicators (Requirement 9.4): a metric/endpoint
//     that lacks data returns an explicit `status: "insufficient-data"` (or the
//     module's own equivalent) rather than being omitted, and a transport
//     failure for one item never fails the whole request. Each item is queried
//     independently and its failure is mapped to an insufficient-data / stale
//     indicator.
//   - ≤2s response budget (Requirement 9.5): the Prometheus client is created
//     with a 2s timeout, and the GET endpoints serve from a short-lived cache so
//     repeated calls under single-user load return immediately without re-hitting
//     Prometheus.
//
// The AI insight and cost-notification concerns are provided through injectable
// seams (InsightSource, CostNotificationStore) so the Phase 4 scheduler /
// costguard wiring can populate them later without changing this module. Default
// in-memory implementations return well-formed empty / "no insight yet"
// responses so the endpoints exist and behave correctly today.
//
// Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 14.1, 14.2

import express, { type Express, type Request, type Response } from "express";

import { estimateComplexity } from "./complexity.js";
import { estimateRunway } from "./forecast.js";
import {
  buildMemoryByVolumeQuery,
  buildP95LatencyByLoadQuery,
  PromTransportError,
  type PromClient,
} from "./promql.js";
import { ThresholdStore } from "./thresholds.js";
import type {
  AiExplanation,
  Band,
  ComplexityEstimate,
  CostNotification,
  FitInput,
  RunwayEstimate,
  Sample,
} from "./types.js";

// ---------------------------------------------------------------------------
// Injectable seams for the (not-yet-built) Phase 4 AI + cost-guard components
// ---------------------------------------------------------------------------

/**
 * Source of the latest tier-2 {@link AiExplanation}. The Phase 4 scheduler
 * (task 7.11) stores its most recent explanation here; the API reads it. Until
 * that exists, {@link EmptyInsightSource} returns a well-formed "no insight yet"
 * result so `GET /api/insight` always responds with a valid shape.
 */
export interface InsightSource {
  latest(): AiExplanation | undefined;
}

/**
 * Store of zero-cost-guardrail notifications (Requirement 13). The Phase 4
 * costguard (task 7.4) will implement raise/persist/acknowledge; the API only
 * needs to read the active (unacknowledged) set and acknowledge by id. Until
 * costguard exists, {@link InMemoryCostNotificationStore} provides an empty,
 * acknowledge-capable default.
 */
export interface CostNotificationStore {
  /** Unacknowledged notifications, newest first is not required. */
  active(): CostNotification[];
  /** Acknowledge a notification by id. Returns true if a match was found. */
  acknowledge(id: string): boolean;
}

/** Default insight source: no explanation available yet. */
export class EmptyInsightSource implements InsightSource {
  latest(): AiExplanation | undefined {
    return undefined;
  }
}

/** Default in-memory cost-notification store (empty by default). */
export class InMemoryCostNotificationStore implements CostNotificationStore {
  private readonly notifications = new Map<string, CostNotification>();

  constructor(initial: CostNotification[] = []) {
    for (const n of initial) {
      this.notifications.set(n.id, n);
    }
  }

  active(): CostNotification[] {
    return [...this.notifications.values()].filter((n) => !n.acknowledged);
  }

  acknowledge(id: string): boolean {
    const existing = this.notifications.get(id);
    if (!existing) return false;
    if (!existing.acknowledged) {
      this.notifications.set(id, { ...existing, acknowledged: true });
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// What the API knows how to query: endpoints and tracked metrics
// ---------------------------------------------------------------------------

/**
 * A monitored endpoint whose time + space complexity the API reports. `route`
 * scopes the latency query to a single endpoint; when omitted the query covers
 * the whole app. The same target's memory-by-volume series feeds the space fit.
 */
export interface MonitoredEndpoint {
  /** Stable identifier surfaced in the API, e.g. "GET /orders". */
  endpoint: string;
  /** Optional route label value to scope the latency query. */
  route?: string;
}

/**
 * A tracked metric whose runway-to-critical the API reports. The PromQL
 * `query` yields the metric's recent history; `redBandStart` and
 * `approachFromBelow` come from its threshold band (design.md forecast.ts).
 */
export interface TrackedMetric {
  /** Metric name; must match a ThresholdStore metric for band classification. */
  metric: string;
  /** Instant/range PromQL query producing the metric's current value. */
  query: string;
  /**
   * PromQL range query producing the metric's recent history for forecasting.
   * When omitted the forecast is reported as insufficient-data.
   */
  historyQuery?: string;
  /** Value at which the Red_Band (Critical_Range) begins. */
  redBandStart?: number;
  /** Whether a rising value crosses into the red band (default true). */
  approachFromBelow?: boolean;
}

/** Configuration describing what this API instance monitors. */
export interface ApiTargets {
  endpoints: MonitoredEndpoint[];
  metrics: TrackedMetric[];
}

// ---------------------------------------------------------------------------
// Response shapes (match design.md "JSON API Design" example)
// ---------------------------------------------------------------------------

/** Per-endpoint time + space complexity, insufficient-data surfaced explicitly. */
export interface EndpointComplexity {
  endpoint: string;
  time: ComplexityEstimate;
  space: ComplexityEstimate;
}

export interface ComplexityResponse {
  endpoints: EndpointComplexity[];
}

/** Per-metric runway estimate, with the metric name attached. */
export interface MetricRunway {
  metric: string;
  runway: RunwayEstimate;
}

export interface RunwayResponse {
  metrics: MetricRunway[];
}

/** Per-metric current band classification (Requirement 9.3). */
export interface MetricBand {
  metric: string;
  band: Band;
  /** Percentage of the critical threshold in use, when a red band is configured. */
  percentOfCritical?: number;
}

export interface BandsResponse {
  metrics: MetricBand[];
}

/**
 * `GET /api/insight` response. When no explanation is available yet a
 * well-formed "no-findings" {@link AiExplanation} is returned rather than a
 * null body, so the Simple_View can render a consistent shape.
 */
export interface InsightResponse {
  insight: AiExplanation;
}

// ---------------------------------------------------------------------------
// Factory dependencies + options
// ---------------------------------------------------------------------------

/** Injected dependencies for {@link createApp}, all mockable in tests. */
export interface ApiDeps {
  prom: PromClient;
  thresholds: ThresholdStore;
  targets: ApiTargets;
  insight?: InsightSource;
  costNotifications?: CostNotificationStore;
}

/** Optional tuning knobs. */
export interface ApiOptions {
  /**
   * How long (ms) a computed GET response is served from cache before the next
   * call recomputes it. Keeps repeated single-user calls within the ≤2s budget
   * (Requirement 9.5). Default 5000ms. Set to 0 to disable caching.
   */
  cacheTtlMs?: number;
  /** Forecast lookback window (ms). Default 7 days (matches forecast.ts). */
  lookbackMs?: number;
  /** Forecast extrapolation horizon (ms). Default 30 days. */
  horizonMs?: number;
  /** Clock, injectable for deterministic tests. Default `Date.now`. */
  now?: () => number;
}

const DEFAULT_CACHE_TTL_MS = 5000;
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Small TTL cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  computedAtMs: number;
}

/**
 * Memoize an async producer for `ttlMs`. A concurrent second call while the
 * first is in flight shares the same promise, so single-user bursts never fan
 * out multiple Prometheus queries.
 */
class TtlCache<T> {
  private entry: CacheEntry<T> | undefined;
  private inFlight: Promise<T> | undefined;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  async get(produce: () => Promise<T>): Promise<T> {
    const t = this.now();
    if (this.entry && t - this.entry.computedAtMs < this.ttlMs) {
      return this.entry.value;
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = produce()
      .then((value) => {
        this.entry = { value, computedAtMs: this.now() };
        return value;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }
}

// ---------------------------------------------------------------------------
// Insufficient-data helpers (Requirement 9.4)
// ---------------------------------------------------------------------------

/** An explicit insufficient-data complexity result (no data / unreachable). */
function insufficientComplexity(distinctLoadLevels = 0): ComplexityEstimate {
  return { status: "insufficient-data", distinctLoadLevels };
}

/** An explicit insufficient-data runway result. */
function insufficientRunway(dataPoints = 0): RunwayEstimate {
  return { status: "insufficient-data", dataPoints };
}

/** The well-formed "no insight yet" explanation used when none is available. */
function noFindingsExplanation(nowMs: number): AiExplanation {
  return { status: "no-findings", generatedAtMs: nowMs };
}

/**
 * Turn a list of Prometheus samples (one per Load_Level series) into curve-fit
 * pairs. Each sample's `value` is the measured metric; we treat the *ordinal*
 * position as a stand-in load axis only if no explicit load is available — but
 * because promql flattens the label away, here we simply require the caller to
 * have produced distinctly-valued samples. To keep distinct load levels
 * meaningful we index the pairs by their sample value's rank.
 *
 * NOTE: promql's builders group by the load/volume label, so each returned
 * Sample corresponds to one load level. We pair each with a synthetic
 * increasing load axis (1..n) preserving order; the complexity fit only needs
 * distinct x values, which this guarantees when the underlying levels differ.
 */
function samplesToPairs(samples: Sample[]): FitInput[] {
  return samples.map((s, i) => ({ load: i + 1, value: s.value }));
}

// ---------------------------------------------------------------------------
// createApp — the testable factory
// ---------------------------------------------------------------------------

/**
 * Build the Express app wiring the injected dependencies into the JSON API.
 * Pure of any I/O side effects beyond the queries the injected `prom` client
 * performs, so tests can supply a mock PromClient / stores and assert response
 * shapes and the ≤2s budget without a live Prometheus or LLM.
 */
export function createApp(deps: ApiDeps, options: ApiOptions = {}): Express {
  const insight = deps.insight ?? new EmptyInsightSource();
  const costNotifications =
    deps.costNotifications ?? new InMemoryCostNotificationStore();
  const now = options.now ?? (() => Date.now());
  const cacheTtlMs =
    options.cacheTtlMs === undefined ? DEFAULT_CACHE_TTL_MS : options.cacheTtlMs;
  const lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const horizonMs = options.horizonMs ?? DEFAULT_HORIZON_MS;

  const complexityCache = new TtlCache<ComplexityResponse>(cacheTtlMs, now);
  const runwayCache = new TtlCache<RunwayResponse>(cacheTtlMs, now);
  const bandsCache = new TtlCache<BandsResponse>(cacheTtlMs, now);

  // ---- per-item computation (each isolated so one failure ≠ whole-request failure)

  async function computeEndpointComplexity(
    ep: MonitoredEndpoint,
  ): Promise<EndpointComplexity> {
    const time = await safeComplexity(() =>
      deps.prom.instant(buildP95LatencyByLoadQuery({ route: ep.route })),
    );
    const space = await safeComplexity(() =>
      deps.prom.instant(buildMemoryByVolumeQuery()),
    );
    return { endpoint: ep.endpoint, time, space };
  }

  async function safeComplexity(
    query: () => Promise<Sample[]>,
  ): Promise<ComplexityEstimate> {
    try {
      const samples = await query();
      if (samples.length === 0) {
        // Successful query, no matching series: genuinely insufficient data.
        return insufficientComplexity(0);
      }
      return estimateComplexity(samplesToPairs(samples));
    } catch (err) {
      // Transport failure (unreachable/timeout): map to insufficient-data for
      // this item only, never fail the whole request (Requirement 9.4).
      if (err instanceof PromTransportError) {
        return insufficientComplexity(0);
      }
      throw err;
    }
  }

  async function computeMetricRunway(m: TrackedMetric): Promise<MetricRunway> {
    if (m.historyQuery === undefined || m.redBandStart === undefined) {
      return { metric: m.metric, runway: insufficientRunway(0) };
    }
    try {
      const endMs = now();
      const startMs = endMs - lookbackMs;
      const history = await deps.prom.range({
        query: m.historyQuery,
        startMs,
        endMs,
        stepSeconds: 60,
      });
      const runway = estimateRunway({
        history,
        redBandStart: m.redBandStart,
        lookbackMs,
        horizonMs,
        approachFromBelow: m.approachFromBelow ?? true,
      });
      return { metric: m.metric, runway };
    } catch (err) {
      if (err instanceof PromTransportError) {
        return { metric: m.metric, runway: insufficientRunway(0) };
      }
      throw err;
    }
  }

  async function computeMetricBand(m: TrackedMetric): Promise<MetricBand> {
    try {
      const samples = await deps.prom.instant(m.query);
      if (samples.length === 0) {
        // No current value: classify as unknown (retains last known band via
        // the store) with no percent-of-critical.
        const band = deps.thresholds.classify(m.metric, NaN);
        return { metric: m.metric, band };
      }
      const value = samples[samples.length - 1]!.value;
      const band = deps.thresholds.classify(m.metric, value);
      const pct = deps.thresholds.percentOfCritical(m.metric, value);
      const result: MetricBand = { metric: m.metric, band };
      if (pct !== undefined) result.percentOfCritical = pct;
      return result;
    } catch (err) {
      if (err instanceof PromTransportError) {
        // Unreachable: fall back to last known band (unknown if none).
        const band = deps.thresholds.classify(m.metric, NaN);
        return { metric: m.metric, band };
      }
      throw err;
    }
  }

  // ---- Express app

  const app = express();
  app.use(express.json());

  // GET /api/complexity — all endpoints (Requirement 9.1)
  app.get("/api/complexity", async (_req: Request, res: Response) => {
    const body = await complexityCache.get(async () => {
      const endpoints = await Promise.all(
        deps.targets.endpoints.map((ep) => computeEndpointComplexity(ep)),
      );
      return { endpoints };
    });
    res.json(body);
  });

  // GET /api/complexity/:endpoint — single endpoint (Requirement 9.1)
  app.get("/api/complexity/:endpoint", async (req: Request, res: Response) => {
    const id = req.params.endpoint;
    const ep = deps.targets.endpoints.find((e) => e.endpoint === id);
    if (!ep) {
      // Unknown endpoint: explicit insufficient-data rather than a hard error.
      res.json({
        endpoint: id,
        time: insufficientComplexity(0),
        space: insufficientComplexity(0),
      } satisfies EndpointComplexity);
      return;
    }
    const body = await computeEndpointComplexity(ep);
    res.json(body);
  });

  // GET /api/runway — per tracked metric (Requirement 9.2)
  app.get("/api/runway", async (_req: Request, res: Response) => {
    const body = await runwayCache.get(async () => {
      const metrics = await Promise.all(
        deps.targets.metrics.map((m) => computeMetricRunway(m)),
      );
      return { metrics };
    });
    res.json(body);
  });

  // GET /api/bands — current classification per metric (Requirement 9.3)
  app.get("/api/bands", async (_req: Request, res: Response) => {
    const body = await bandsCache.get(async () => {
      const metrics = await Promise.all(
        deps.targets.metrics.map((m) => computeMetricBand(m)),
      );
      return { metrics };
    });
    res.json(body);
  });

  // GET /api/insight — latest AiExplanation + evidence (Requirement 12)
  app.get("/api/insight", (_req: Request, res: Response) => {
    const latest = insight.latest() ?? noFindingsExplanation(now());
    res.json({ insight: latest } satisfies InsightResponse);
  });

  // GET /api/cost-notifications — active (unacknowledged) (Requirement 13)
  app.get("/api/cost-notifications", (_req: Request, res: Response) => {
    res.json({ notifications: costNotifications.active() });
  });

  // POST /api/cost-notifications/:id/ack — acknowledge by id (Requirement 13.3)
  app.post(
    "/api/cost-notifications/:id/ack",
    (req: Request, res: Response) => {
      const acknowledged = costNotifications.acknowledge(req.params.id);
      if (!acknowledged) {
        res.status(404).json({ acknowledged: false, id: req.params.id });
        return;
      }
      res.json({ acknowledged: true, id: req.params.id });
    },
  );

  return app;
}
