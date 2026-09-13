// Insight Service entry point.
//
// Constructs the real dependencies (a Prometheus client bounded by the 2s
// timeout, an in-memory ThresholdStore, and the default insight / cost-guard
// seams) from environment variables and starts the JSON API HTTP server
// (design.md "index.ts — HTTP server + JSON API").
//
// Configuration is env-driven with sensible defaults so `docker compose up`
// works with zero config on a single-user machine (Requirement 14):
//   - PROMETHEUS_URL   Prometheus HTTP API base URL   (default http://localhost:9090)
//   - PORT             HTTP port for the JSON API      (default 3001)
//   - PROM_TIMEOUT_MS  Per-query timeout               (default 2000, keeps R9.5 budget)
//
// The server itself is defined by the testable `createApp` factory in api.ts;
// this file only wires the production dependencies and calls `listen`. The
// Phase 4 scheduler (task 7.11) starts the two-tier insight loop and is passed
// as the API's InsightSource; the shared costguard (task 7.4) backs the
// CostNotificationStore seam — both without touching api.ts.

import type { Express } from "express";

import {
  createApp,
  type ApiTargets,
  type InsightSource,
  type CostNotificationStore,
} from "./api.js";
import { createPromClient, DEFAULT_TIMEOUT_MS, type PromClient } from "./promql.js";
import { ThresholdStore } from "./thresholds.js";
import { defaultCostGuard } from "./costguard.js";
import { defaultLlmConfig, type LlmConfig } from "./llm.js";
import {
  startScheduler,
  DEFAULT_INSIGHT_CYCLE_MS,
  clampInsightCycleMs,
  type CycleInputs,
  type Scheduler,
} from "./scheduler.js";
import type { Band, Sample } from "./types.js";

export const SERVICE_NAME = "insight-service";

/** Resolved runtime configuration for the service. */
export interface ServiceConfig {
  prometheusUrl: string;
  port: number;
  promTimeoutMs: number;
  /** Two-tier insight-cycle cadence in ms (clamped to 15..30 min). */
  insightCycleMs: number;
  /** LLM synthesis config for the tier-2 scheduler pass. */
  llm: LlmConfig;
}

/** Read configuration from the environment, applying single-user defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const port = Number.parseInt(env.PORT ?? "", 10);
  const timeout = Number.parseInt(env.PROM_TIMEOUT_MS ?? "", 10);
  const cycle = Number.parseInt(env.INSIGHT_CYCLE_MS ?? "", 10);
  const llm = defaultLlmConfig({
    ...(env.OLLAMA_URL ? { ollamaUrl: env.OLLAMA_URL } : {}),
    ...(env.OLLAMA_MODEL ? { ollamaModel: env.OLLAMA_MODEL } : {}),
  });
  return {
    prometheusUrl: env.PROMETHEUS_URL ?? "http://localhost:9090",
    port: Number.isFinite(port) && port > 0 ? port : 3001,
    promTimeoutMs:
      Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    insightCycleMs:
      Number.isFinite(cycle) && cycle > 0
        ? clampInsightCycleMs(cycle)
        : DEFAULT_INSIGHT_CYCLE_MS,
    llm,
  };
}

/**
 * Default monitored targets. These are intentionally minimal starter targets
 * matching the target-app instrumentation; a real deployment would extend this
 * (or load it from config) as more endpoints/metrics are tracked. Endpoints and
 * metrics with no recorded data simply return insufficient-data (Requirement
 * 9.4), so shipping starter targets is safe.
 */
export function defaultTargets(): ApiTargets {
  return {
    endpoints: [{ endpoint: "target-app" }],
    metrics: [
      {
        metric: "process_resident_memory_bytes",
        query: "process_resident_memory_bytes",
        historyQuery: "process_resident_memory_bytes",
      },
    ],
  };
}

/**
 * Build the scheduler's `collect` seam over the production Prometheus client and
 * threshold store. Each cycle it reads the current value of every tracked
 * metric (an instant query) plus a short recent history (a range query) to feed
 * tier-1 spike detection as the baseline window, and classifies the current
 * value against the store to seed `previousBands`.
 *
 * Any per-metric transport failure is isolated: that metric is simply omitted
 * from this cycle's inputs rather than failing the whole cycle, matching the
 * API's insufficient-data posture (Requirement 9.4). Metrics with no threshold
 * config still flow through so rules.ts can list them as `unmonitored`.
 */
export function buildCollect(
  prom: PromClient,
  thresholds: ThresholdStore,
  targets: ApiTargets,
  now: () => number = () => Date.now(),
  baselineLookbackMs = 15 * 60 * 1000,
): () => Promise<CycleInputs> {
  return async (): Promise<CycleInputs> => {
    const current: Record<string, Sample> = {};
    const previousBands: Record<string, Band> = {};
    const baselines: Record<string, Sample[]> = {};

    await Promise.all(
      targets.metrics.map(async (m) => {
        try {
          const samples = await prom.instant(m.query);
          if (samples.length > 0) {
            const value = samples[samples.length - 1]!.value;
            const tMs = now();
            current[m.metric] = { tMs, value };
            // Seed the metric's prior band from the store's last-known band so a
            // higher-severity crossing this cycle is detectable.
            previousBands[m.metric] = thresholds.classify(m.metric, value);
          }
        } catch {
          // Transport failure for this metric: skip it this cycle.
        }

        if (m.historyQuery !== undefined) {
          try {
            const endMs = now();
            const history = await prom.range({
              query: m.historyQuery,
              startMs: endMs - baselineLookbackMs,
              endMs,
              stepSeconds: 60,
            });
            if (history.length > 0) baselines[m.metric] = history;
          } catch {
            // Transport failure for the baseline: no baseline this cycle.
          }
        }
      }),
    );

    return {
      current,
      previousBands,
      baselines,
      cfg: thresholds.getConfig(),
    };
  };
}

/**
 * Build and start the HTTP server with production dependencies. Also starts the
 * two-tier insight scheduler and passes it as the API's InsightSource, and
 * backs the cost-notification store with the shared costguard. Returns the Node
 * HTTP server (with a `stopScheduler` hook attached) so callers/tests can close
 * it and stop the loop.
 */
export function main(
  config: ServiceConfig = loadConfig(),
  insight?: InsightSource,
  costNotifications?: CostNotificationStore,
): ReturnType<Express["listen"]> & { stopScheduler?: () => void } {
  const prom = createPromClient({
    baseUrl: config.prometheusUrl,
    timeoutMs: config.promTimeoutMs,
  });
  const thresholds = new ThresholdStore();
  const targets = defaultTargets();

  // Start the two-tier insight loop unless the caller injected its own
  // InsightSource (tests do this to avoid a live timer/LLM).
  let scheduler: Scheduler | undefined;
  if (!insight) {
    scheduler = startScheduler(
      { collect: buildCollect(prom, thresholds, targets) },
      { insightCycleMs: config.insightCycleMs, llm: config.llm },
    );
  }

  const app = createApp({
    prom,
    thresholds,
    targets,
    insight: insight ?? scheduler!,
    // Default the cost store to the shared guard so raised free-tier/paid-tier
    // notifications (e.g. from llm.ts) surface on GET /api/cost-notifications.
    costNotifications: costNotifications ?? defaultCostGuard,
  });

  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[${SERVICE_NAME}] JSON API listening on :${config.port} ` +
        `(Prometheus ${config.prometheusUrl}, timeout ${config.promTimeoutMs}ms, ` +
        `insight cycle ${config.insightCycleMs}ms)`,
    );
  });

  // Stop the scheduler when the server closes so the process can exit cleanly.
  const typed = server as ReturnType<Express["listen"]> & {
    stopScheduler?: () => void;
  };
  if (scheduler) {
    const stop = scheduler.stop;
    typed.stopScheduler = stop;
    server.on("close", stop);
  }
  return typed;
}

// Start the server when run directly (not when imported by tests).
// With NodeNext ESM there is no `require.main`; compare the resolved module URL
// to the process entry instead.
const isEntrypoint = (() => {
  try {
    const entry = process.argv[1] ?? "";
    return (
      import.meta.url === `file://${entry}` ||
      import.meta.url.endsWith(entry.replace(/\\/g, "/"))
    );
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  main();
}
