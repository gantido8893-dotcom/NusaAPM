// Prometheus instrumentation for the target app.
//
// Exposes the three metric families required by the APM system (Requirement 1.1):
//   - request latency  -> histogram, enabling p50/p95/p99 (Requirement 2.1)
//   - request throughput -> counter of total requests (feeds req/s via rate())
//   - error count       -> counter of failed (5xx) requests
//
// prom-client is free/OSS (satisfies the $0 hard constraint in AGENTS.md).
import {
  Registry,
  Histogram,
  Counter,
  collectDefaultMetrics,
} from "prom-client";

export interface Metrics {
  registry: Registry;
  httpRequestDuration: Histogram<"method" | "route" | "status_code">;
  httpRequestsTotal: Counter<"method" | "route" | "status_code">;
  httpRequestErrorsTotal: Counter<"method" | "route" | "status_code">;
}

/**
 * Build a fresh registry with the app's instrumentation registered.
 * A dedicated registry (rather than the global default) keeps the metrics
 * isolated and makes the module safe to instantiate repeatedly in tests.
 */
export function createMetrics(): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ app: "target-app" });

  // Host/runtime defaults (process RSS, heap, event loop, etc.) support the
  // memory metrics the complexity engine consumes (Requirement 2.3).
  collectDefaultMetrics({ register: registry });

  const httpRequestDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request latency in seconds. Buckets enable p50/p95/p99 via histogram_quantile.",
    labelNames: ["method", "route", "status_code"] as const,
    // Buckets spanning fast (5ms) to slow (5s) requests so the varied-latency
    // load route lands across multiple buckets for meaningful quantiles.
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  const httpRequestsTotal = new Counter({
    name: "http_requests_total",
    help: "Total number of HTTP requests handled, labelled by method, route, and status code.",
    labelNames: ["method", "route", "status_code"] as const,
    registers: [registry],
  });

  const httpRequestErrorsTotal = new Counter({
    name: "http_request_errors_total",
    help: "Total number of HTTP requests that resulted in a server error (status >= 500).",
    labelNames: ["method", "route", "status_code"] as const,
    registers: [registry],
  });

  return {
    registry,
    httpRequestDuration,
    httpRequestsTotal,
    httpRequestErrorsTotal,
  };
}

/**
 * Record a completed request against all three metric families.
 * Centralises label construction so every route reports consistently.
 */
export function recordRequest(
  metrics: Metrics,
  args: {
    method: string;
    route: string;
    statusCode: number;
    durationSeconds: number;
  },
): void {
  const labels = {
    method: args.method,
    route: args.route,
    status_code: String(args.statusCode),
  };
  metrics.httpRequestDuration.observe(labels, args.durationSeconds);
  metrics.httpRequestsTotal.inc(labels);
  if (args.statusCode >= 500) {
    metrics.httpRequestErrorsTotal.inc(labels);
  }
}
