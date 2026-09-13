// Feature: personal-ai-apm-system
// Example-based unit tests for rules.ts edge cases (task 7.3).
//
// Validates:
//   Requirement 10.2 — a metric with no threshold config is skipped for
//                      crossing detection and listed in `unmonitored`, without
//                      halting analysis of the other metrics.
//   Requirement 10.3 — spike detection uses a STRICTLY-greater test against
//                      `deviationSigma * stdDev`: a value exactly AT the
//                      threshold is NOT a spike; just over IS.
//   Requirement 10.4 — correlation detection uses a `<=` test against the
//                      window: a gap exactly AT the window boundary IS
//                      correlated; just beyond is NOT.
//   Requirement 10.5 — when no detector finds anything the summary is returned
//                      with `empty: true`.
//
// analyze(current, previousBands, baselines, cfg, opts) is pure, so each case
// is a plain input/output assertion — no mocking needed.

import { describe, it, expect } from "vitest";
import {
  analyze,
  DEFAULT_CORRELATION_WINDOW_MS,
  DEFAULT_DEVIATION_SIGMA,
} from "./rules.js";
import type { Band, MetricThreshold, Sample, ThresholdConfig } from "./types.js";

// Canonical contiguous, gap-free, non-overlapping band config:
//   green=[0,10)  yellow=[10,20)  red=[20,30)
function band(metric: string): MetricThreshold {
  return {
    metric,
    green: { min: 0, max: 10 },
    yellow: { min: 10, max: 20 },
    red: { min: 20, max: 30 },
  };
}

function cfgFor(...metrics: string[]): ThresholdConfig {
  const out: Record<string, MetricThreshold> = {};
  for (const m of metrics) out[m] = band(m);
  return { metrics: out };
}

const s = (tMs: number, value: number): Sample => ({ tMs, value });

// ---------------------------------------------------------------------------
// Requirement 10.5 — no findings yields empty: true
// ---------------------------------------------------------------------------

describe("analyze — no findings yields an empty summary (Requirement 10.5)", () => {
  it("returns empty:true with no crossings, spikes, or correlations", () => {
    // A single metric that stays green (no crossing), with no baseline history
    // (no spike possible) and only one crossing candidate (no correlation).
    const current: Record<string, Sample> = { latency: s(1000, 5) };
    const previousBands: Record<string, Band> = { latency: "green" };
    const baselines: Record<string, Sample[]> = {};

    const summary = analyze(current, previousBands, baselines, cfgFor("latency"));

    expect(summary.empty).toBe(true);
    expect(summary.bandCrossings).toEqual([]);
    expect(summary.spikes).toEqual([]);
    expect(summary.correlations).toEqual([]);
    expect(summary.unmonitored).toEqual([]);
    // cycleTMs is the latest tMs among current samples.
    expect(summary.cycleTMs).toBe(1000);
  });

  it("returns empty:true for an entirely empty cycle", () => {
    const summary = analyze({}, {}, {}, { metrics: {} });
    expect(summary.empty).toBe(true);
    expect(summary.cycleTMs).toBe(0);
    expect(summary.bandCrossings).toEqual([]);
    expect(summary.spikes).toEqual([]);
    expect(summary.correlations).toEqual([]);
    expect(summary.unmonitored).toEqual([]);
  });

  it("staying in the same band is not a crossing (severity must strictly increase)", () => {
    const summary = analyze(
      { latency: s(1000, 5) },
      { latency: "green" }, // same band -> no crossing
      {},
      cfgFor("latency"),
    );
    expect(summary.bandCrossings).toEqual([]);
    expect(summary.empty).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Requirement 10.2 — unmonitored metric skipped without halting others
// ---------------------------------------------------------------------------

describe("analyze — unmonitored metric is skipped and listed (Requirement 10.2)", () => {
  it("a metric with no threshold config appears in `unmonitored`", () => {
    const summary = analyze(
      { mystery: s(1000, 42) },
      {},
      {},
      { metrics: {} }, // no config for `mystery`
    );
    expect(summary.unmonitored).toEqual(["mystery"]);
    expect(summary.bandCrossings).toEqual([]);
  });

  it("skips the unconfigured metric but still detects a crossing on a configured one", () => {
    // `latency` is configured and crosses green -> red; `mystery` has no config.
    const current: Record<string, Sample> = {
      latency: s(1000, 25), // red
      mystery: s(1000, 999), // no config
    };
    const previousBands: Record<string, Band> = { latency: "green" };

    const summary = analyze(current, previousBands, {}, cfgFor("latency"));

    // The unconfigured metric did not halt detection of the configured one.
    expect(summary.unmonitored).toEqual(["mystery"]);
    expect(summary.bandCrossings).toHaveLength(1);
    expect(summary.bandCrossings[0]).toMatchObject({
      metric: "latency",
      from: "green",
      to: "red",
      tMs: 1000,
    });
    expect(summary.empty).toBe(false);
  });

  it("an unconfigured metric alone never produces a crossing (empty crossings)", () => {
    const summary = analyze({ mystery: s(500, 5) }, {}, {}, { metrics: {} });
    expect(summary.bandCrossings).toEqual([]);
    expect(summary.unmonitored).toEqual(["mystery"]);
  });
});

// ---------------------------------------------------------------------------
// Requirement 10.3 — spike at exactly the deviation threshold is NOT flagged
// ---------------------------------------------------------------------------

describe("analyze — spike threshold is strictly-greater (Requirement 10.3)", () => {
  // Baseline values [10, 20] -> mean = 15, population stdDev = 5.
  // With deviationSigma = 1, the spike boundary is |value - 15| > 1 * 5 = 5,
  // i.e. values at 20 or 10 are exactly AT the threshold (deviation == 5).
  const baselines: Record<string, Sample[]> = {
    latency: [s(1000, 10), s(2000, 20)],
  };
  // A green band wide enough that these values never trigger a crossing, so we
  // isolate spike behavior from crossing behavior.
  const wideCfg: ThresholdConfig = {
    metrics: {
      latency: {
        metric: "latency",
        green: { min: -1000, max: 1000 },
        yellow: { min: 1000, max: 2000 },
        red: { min: 2000, max: 3000 },
      },
    },
  };

  it("a value exactly AT the deviation threshold is NOT a spike", () => {
    // deviation = |20 - 15| = 5, threshold = 1 * 5 = 5 -> 5 > 5 is false.
    const summary = analyze(
      { latency: s(3000, 20) },
      { latency: "green" },
      baselines,
      wideCfg,
      { deviationSigma: 1 },
    );
    expect(summary.spikes).toEqual([]);
  });

  it("a value just OVER the deviation threshold IS a spike", () => {
    // deviation = |21 - 15| = 6 > 5 -> flagged.
    const summary = analyze(
      { latency: s(3000, 21) },
      { latency: "green" },
      baselines,
      wideCfg,
      { deviationSigma: 1 },
    );
    expect(summary.spikes).toHaveLength(1);
    expect(summary.spikes[0]).toMatchObject({
      metric: "latency",
      value: 21,
      mean: 15,
      stdDev: 5,
      tMs: 3000,
    });
    expect(summary.empty).toBe(false);
  });

  it("the default deviation sigma is 3", () => {
    // Sanity anchor for the threshold arithmetic above.
    expect(DEFAULT_DEVIATION_SIGMA).toBe(3);
  });

  it("baseline samples outside the window are excluded from the mean/stdDev", () => {
    // cycleTMs = 3000; with a 500ms baseline window only the sample at 3000
    // qualifies (a single point -> stdDev 0 -> no spike possible).
    const summary = analyze(
      { latency: s(3000, 21) },
      { latency: "green" },
      { latency: [s(1000, 10), s(2000, 20), s(3000, 20)] },
      wideCfg,
      { deviationSigma: 1, baselineWindowMs: 500 },
    );
    expect(summary.spikes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Requirement 10.4 — correlation at exactly the window boundary IS recorded
// ---------------------------------------------------------------------------

describe("analyze — correlation window boundary is inclusive (Requirement 10.4)", () => {
  // Two metrics that both cross green -> red. Their crossing times differ by
  // exactly the default correlation window (60s).
  const cfg = cfgFor("latency", "cpu");
  const previousBands: Record<string, Band> = { latency: "green", cpu: "green" };

  it("a gap exactly AT the window boundary IS correlated", () => {
    const current: Record<string, Sample> = {
      latency: s(1_000, 25), // crossing at t=1000
      cpu: s(61_000, 25), // crossing at t=61000 -> gap = 60000 == window
    };
    const summary = analyze(current, previousBands, {}, cfg);

    expect(summary.bandCrossings).toHaveLength(2);
    expect(summary.correlations).toHaveLength(1);
    expect(summary.correlations[0].withinMs).toBe(DEFAULT_CORRELATION_WINDOW_MS);
    const pair = [summary.correlations[0].metricA, summary.correlations[0].metricB].sort();
    expect(pair).toEqual(["cpu", "latency"]);
  });

  it("a gap just BEYOND the window boundary is NOT correlated", () => {
    const current: Record<string, Sample> = {
      latency: s(1_000, 25),
      cpu: s(61_001, 25), // gap = 60001 > 60000
    };
    const summary = analyze(current, previousBands, {}, cfg);

    expect(summary.bandCrossings).toHaveLength(2);
    expect(summary.correlations).toEqual([]);
  });

  it("respects a custom correlation window at its exact boundary", () => {
    const current: Record<string, Sample> = {
      latency: s(0, 25),
      cpu: s(10_000, 25), // gap = 10000
    };
    const atBoundary = analyze(current, previousBands, {}, cfg, {
      correlationWindowMs: 10_000,
    });
    expect(atBoundary.correlations).toHaveLength(1);
    expect(atBoundary.correlations[0].withinMs).toBe(10_000);

    const justUnder = analyze(current, previousBands, {}, cfg, {
      correlationWindowMs: 9_999,
    });
    expect(justUnder.correlations).toEqual([]);
  });

  it("the default correlation window is 60 seconds", () => {
    expect(DEFAULT_CORRELATION_WINDOW_MS).toBe(60 * 1000);
  });
});
