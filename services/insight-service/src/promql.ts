// promql.ts — Prometheus HTTP API client.
//
// Queries the self-hosted Metrics_Store (Prometheus) over its HTTP API:
//   - instant queries via `/api/v1/query`         (design.md "promql.ts")
//   - range queries   via `/api/v1/query_range`
//   - scrape-target health via `/api/v1/targets`  (for staleness / down detection)
//
// It provides the typed helpers the analysis modules (complexity.ts,
// forecast.ts, rules.ts) consume, plus PromQL builders for the two curve-fit
// input series the system needs:
//   - (Load_Level, p95 latency) pairs  (Requirement 6.1)
//   - (data volume, memory RSS) pairs  (Requirement 7.1)
//
// Error semantics (Requirements 2.7, 4.4, 9.4): a *transport* failure — the
// Metrics_Store being unreachable, timing out, or returning a non-OK / error
// status — is surfaced as a thrown `PromTransportError` so callers can map it
// to a stale / insufficient-data indication. A *successful* query that simply
// matched no series is NOT an error: it returns an empty array. Distinguishing
// these two cases is the whole point of this module.
//
// A default 2000ms timeout keeps every query inside the JSON API's ≤2s response
// budget (Requirement 9.5). Node >=18 provides a global `fetch` and
// `AbortController`, so no HTTP dependency is required.
//
// Requirements: 2.7, 4.4, 6.1, 7.1, 9.4, 9.5

import type { Sample } from "./types.js";

/** Default per-query timeout; keeps the JSON API within its ≤2s budget (R9.5). */
export const DEFAULT_TIMEOUT_MS = 2000;

/** Configuration for a {@link PromClient}. */
export interface PromClientConfig {
  /** Base URL of the Prometheus HTTP API, e.g. `http://prometheus:9090`. */
  baseUrl: string;
  /** Per-query timeout in milliseconds. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Options for a range query against `/api/v1/query_range`. */
export interface RangeQueryOptions {
  /** PromQL expression. */
  query: string;
  /** Range start, epoch milliseconds. */
  startMs: number;
  /** Range end, epoch milliseconds. */
  endMs: number;
  /** Resolution step, in seconds. */
  stepSeconds: number;
}

/** Typed helpers the analysis modules consume. */
export interface PromClient {
  /** Instant query (`/api/v1/query`). Returns matched samples, or `[]` when none match. */
  instant(query: string): Promise<Sample[]>;
  /** Range query (`/api/v1/query_range`). Returns the flattened series, or `[]` when none match. */
  range(opts: RangeQueryOptions): Promise<Sample[]>;
  /** Scrape-target health keyed by target instance, for staleness / down detection. */
  targetsUp(): Promise<Record<string, boolean>>;
}

/**
 * Thrown when the Metrics_Store cannot be reached, times out, or returns an
 * error/non-OK response. This is the "unreachable" signal, deliberately
 * distinct from a successful-but-empty query result (which returns `[]`).
 * Callers map this to a stale / insufficient-data indication
 * (Requirements 2.7, 4.4, 9.4).
 */
export class PromTransportError extends Error {
  constructor(
    message: string,
    /** The original cause, when available (network error, abort, etc.). */
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PromTransportError";
  }
}

// ---------------------------------------------------------------------------
// Prometheus HTTP API response shapes
// ---------------------------------------------------------------------------

/** A `[unixSeconds, "stringValue"]` sample tuple as returned by Prometheus. */
type PromValueTuple = [number, string];

interface PromVectorResult {
  metric: Record<string, string>;
  value: PromValueTuple;
}

interface PromMatrixResult {
  metric: Record<string, string>;
  values: PromValueTuple[];
}

interface PromQueryResponse {
  status: "success" | "error";
  errorType?: string;
  error?: string;
  data?: {
    resultType: "vector" | "matrix" | "scalar" | "string";
    result: PromVectorResult[] | PromMatrixResult[] | PromValueTuple | [number, string];
  };
}

interface PromActiveTarget {
  labels?: Record<string, string>;
  scrapeUrl?: string;
  health?: string; // "up" | "down" | "unknown"
}

interface PromTargetsResponse {
  status: "success" | "error";
  errorType?: string;
  error?: string;
  data?: {
    activeTargets?: PromActiveTarget[];
  };
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Parse a Prometheus `[unixSeconds, "value"]` tuple into a {@link Sample}. */
function tupleToSample(tuple: PromValueTuple): Sample {
  const [unixSeconds, valueStr] = tuple;
  return { tMs: Math.round(unixSeconds * 1000), value: Number(valueStr) };
}

/**
 * Flatten a successful query `data` payload into samples.
 * Vector results contribute one sample per series; matrix results contribute
 * one sample per point across all series (chronologically ordered per series).
 * An empty result set yields `[]` — a valid "no data" answer, not an error.
 */
function extractSamples(data: PromQueryResponse["data"]): Sample[] {
  if (!data) return [];
  switch (data.resultType) {
    case "vector": {
      const result = data.result as PromVectorResult[];
      return result.map((r) => tupleToSample(r.value));
    }
    case "matrix": {
      const result = data.result as PromMatrixResult[];
      const samples: Sample[] = [];
      for (const series of result) {
        for (const point of series.values) {
          samples.push(tupleToSample(point));
        }
      }
      samples.sort((a, b) => a.tMs - b.tMs);
      return samples;
    }
    case "scalar": {
      return [tupleToSample(data.result as PromValueTuple)];
    }
    default:
      // "string" and any unexpected type carry no numeric time series.
      return [];
  }
}

// ---------------------------------------------------------------------------
// Client implementation
// ---------------------------------------------------------------------------

/**
 * Concrete {@link PromClient} backed by the global `fetch` (Node >=18).
 * All requests are bounded by `timeoutMs` via an `AbortController`.
 */
export class HttpPromClient implements PromClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: PromClientConfig) {
    // Trim a trailing slash so path joins are unambiguous.
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.timeoutMs =
      config.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : config.timeoutMs;
  }

  async instant(query: string): Promise<Sample[]> {
    const params = new URLSearchParams({ query });
    const body = await this.getJson<PromQueryResponse>(
      `/api/v1/query?${params.toString()}`,
    );
    assertQuerySuccess(body);
    return extractSamples(body.data);
  }

  async range(opts: RangeQueryOptions): Promise<Sample[]> {
    const params = new URLSearchParams({
      query: opts.query,
      // Prometheus expects RFC3339 or a unix timestamp in seconds.
      start: String(opts.startMs / 1000),
      end: String(opts.endMs / 1000),
      step: String(opts.stepSeconds),
    });
    const body = await this.getJson<PromQueryResponse>(
      `/api/v1/query_range?${params.toString()}`,
    );
    assertQuerySuccess(body);
    return extractSamples(body.data);
  }

  async targetsUp(): Promise<Record<string, boolean>> {
    const body = await this.getJson<PromTargetsResponse>("/api/v1/targets");
    if (body.status !== "success") {
      throw new PromTransportError(
        `Prometheus targets query returned status "${body.status}"` +
          (body.error ? `: ${body.error}` : ""),
      );
    }
    const up: Record<string, boolean> = {};
    for (const target of body.data?.activeTargets ?? []) {
      const key =
        target.labels?.instance ?? target.labels?.job ?? target.scrapeUrl;
      if (key !== undefined) {
        up[key] = target.health === "up";
      }
    }
    return up;
  }

  /**
   * Perform a timeout-bounded GET and parse the JSON body. Any network error,
   * timeout/abort, non-OK HTTP status, or unparseable body is a transport
   * failure and surfaces as {@link PromTransportError}.
   */
  private async getJson<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (err) {
      const aborted =
        err instanceof Error &&
        (err.name === "AbortError" || controller.signal.aborted);
      throw new PromTransportError(
        aborted
          ? `Prometheus request timed out after ${this.timeoutMs}ms: ${path}`
          : `Prometheus request failed: ${path}`,
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new PromTransportError(
        `Prometheus returned HTTP ${response.status} for ${path}`,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new PromTransportError(
        `Failed to parse Prometheus JSON response for ${path}`,
        err,
      );
    }
  }
}

/**
 * Prometheus reports query-level failures with `status:"error"` inside an
 * otherwise-200 body. Treat that as a transport failure so callers map it to a
 * stale / insufficient-data indication rather than mistaking it for "no data".
 */
function assertQuerySuccess(body: PromQueryResponse): void {
  if (body.status !== "success") {
    throw new PromTransportError(
      `Prometheus query returned status "${body.status}"` +
        (body.error ? `: ${body.error}` : ""),
    );
  }
}

/** Construct the default {@link HttpPromClient} for the given config. */
export function createPromClient(config: PromClientConfig): PromClient {
  return new HttpPromClient(config);
}

// ---------------------------------------------------------------------------
// PromQL builders for the curve-fit input series
// ---------------------------------------------------------------------------

/**
 * Options for the p95-latency-by-load-level query (Requirement 6.1).
 * The target app exposes `http_request_duration_seconds` as a histogram with a
 * `route` label (see services/target-app/src/metrics.ts). The Load_Level label
 * distinguishes the observed demand levels whose p95 latency we curve-fit.
 */
export interface P95LatencyByLoadOptions {
  /** Histogram metric base name. Default: `http_request_duration_seconds`. */
  metric?: string;
  /** Label carrying the Load_Level (concurrency / payload size / rows). Default: `load_level`. */
  loadLabel?: string;
  /** Optional endpoint/route to scope the query to a single endpoint. */
  route?: string;
  /** Label carrying the route/endpoint. Default: `route`. */
  routeLabel?: string;
  /** Rate window for the histogram buckets. Default: `5m`. */
  rateWindow?: string;
}

/**
 * Build a PromQL expression yielding p95 latency grouped by Load_Level, so an
 * instant query returns one `(Load_Level, p95 latency)` point per load level
 * (Requirement 6.1). The Load_Level itself is the series' `loadLabel` value;
 * callers pair it with the returned {@link Sample.value}.
 */
export function buildP95LatencyByLoadQuery(
  opts: P95LatencyByLoadOptions = {},
): string {
  const metric = opts.metric ?? "http_request_duration_seconds";
  const loadLabel = opts.loadLabel ?? "load_level";
  const routeLabel = opts.routeLabel ?? "route";
  const rateWindow = opts.rateWindow ?? "5m";

  const selector =
    opts.route === undefined
      ? `${metric}_bucket`
      : `${metric}_bucket{${routeLabel}="${escapeLabelValue(opts.route)}"}`;

  return (
    `histogram_quantile(0.95, ` +
    `sum(rate(${selector}[${rateWindow}])) by (le, ${loadLabel}))`
  );
}

/**
 * Options for the (data volume, memory RSS) space-complexity query
 * (Requirement 7.1).
 */
export interface MemoryByVolumeOptions {
  /** Resident-set-size gauge. Default: `process_resident_memory_bytes` (prom-client default). */
  rssMetric?: string;
  /** Label carrying the data-volume level. Default: `data_volume`. */
  volumeLabel?: string;
}

/**
 * Build a PromQL expression yielding memory RSS grouped by data-volume level,
 * so an instant query returns one `(data volume, memory RSS)` point per volume
 * level (Requirement 7.1). As with latency, the data-volume level is the
 * series' `volumeLabel` value paired with the returned RSS {@link Sample.value}.
 */
export function buildMemoryByVolumeQuery(
  opts: MemoryByVolumeOptions = {},
): string {
  const rssMetric = opts.rssMetric ?? "process_resident_memory_bytes";
  const volumeLabel = opts.volumeLabel ?? "data_volume";
  return `max(${rssMetric}) by (${volumeLabel})`;
}

/** Escape a PromQL label value for safe interpolation into a selector. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
