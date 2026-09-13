// Feature: personal-ai-apm-system
// Property-based tests for rules.ts (design.md "Correctness Properties").
//
// Covers:
//   Property 9: Structured summary completeness                    (task 7.2)
//   Validates: Requirements 10.5
//
// The property: for any set of findings detected in a cycle, the
// StructuredSummary returned by `analyze` contains EVERY detected band
// crossing, spike, and correlation (nothing dropped, nothing invented), and the
// `empty` flag is true if and only if no band crossing, spike, or correlation
// was detected.
//
// Strategy: we generate arbitrary current samples, previous bands, baselines,
// and a threshold config, call `analyze`, then independently re-derive the
// findings with an oracle written against the spec (not by calling the module
// internals). The summary must agree with the oracle set-for-set and its
// `empty` flag must match the emptiness of the union of findings.
//
// The module under test is pure/deterministic, so no mocking is needed and the
// tests stay free (Requirement 13).

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  analyze,
  DEFAULT_BASELINE_WINDOW_MS,
  DEFAULT_DEVIATION_SIGMA,
  DEFAULT_CORRELATION_WINDOW_MS,
  MIN_CORRELATION_WINDOW_MS,
  MAX_CORRELATION_WINDOW_MS,
  type RuleOptions,
} from "./rules.js";
import type {
  Band,
  MetricThreshold,
  Sample,
  ThresholdConfig,
} from "./types.js";

const RUNS = 200; // >= 100 iterations per task requirement

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// A small, fixed metric-name universe keeps collisions (shared metrics across
// current/previous/baseline/config) frequent, so both the crossing and
// unmonitored paths are exercised heavily.
const metricNameArb = fc.constantFrom("cpu", "mem", "lat", "err", "disk");

const sampleArb: fc.Arbitrary<Sample> = fc.record({
  tMs: fc.integer({ min: 0, max: 2_000_000 }),
  value: fc.double({ min: -100, max: 100, noNaN: true }),
});

/**
 * A well-formed contiguous MetricThreshold laid out green<yellow<red so its
 * classify() behaviour is unambiguous. Boundaries are chosen inside the sample
 * value range (-100..100) so values land in every band with good frequency.
 */
const metricThresholdArb: fc.Arbitrary<MetricThreshold> = fc
  .record({
    metric: metricNameArb,
    base: fc.integer({ min: -80, max: -20 }),
    w1: fc.integer({ min: 5, max: 40 }),
    w2: fc.integer({ min: 5, max: 40 }),
    w3: fc.integer({ min: 5, max: 40 }),
  })
  .map(({ metric, base, w1, w2, w3 }) => {
    const b0 = base;
    const b1 = b0 + w1;
    const b2 = b1 + w2;
    const b3 = b2 + w3;
    return {
      metric,
      green: { min: b0, max: b1 },
      yellow: { min: b1, max: b2 },
      red: { min: b2, max: b3 },
    } satisfies MetricThreshold;
  });

/** A ThresholdConfig covering a random subset of the metric universe. */
const thresholdConfigArb: fc.Arbitrary<ThresholdConfig> = fc
  .array(metricThresholdArb, { minLength: 0, maxLength: 5 })
  .map((ts) => {
    const metrics: Record<string, MetricThreshold> = {};
    for (const t of ts) metrics[t.metric] = { ...t, metric: t.metric };
    return { metrics };
  });

/** Current samples: a record over a subset of the metric universe. */
const currentArb: fc.Arbitrary<Record<string, Sample>> = fc.dictionary(
  metricNameArb,
  sampleArb,
  { minKeys: 0, maxKeys: 5 },
);

const bandArb: fc.Arbitrary<Band> = fc.constantFrom<Band>(
  "green",
  "yellow",
  "red",
  "unknown",
);

/** Previous bands: a record over a subset of the metric universe. */
const previousBandsArb: fc.Arbitrary<Record<string, Band>> = fc.dictionary(
  metricNameArb,
  bandArb,
  { minKeys: 0, maxKeys: 5 },
);

/** Baselines: per-metric arrays of samples for spike detection. */
const baselinesArb: fc.Arbitrary<Record<string, Sample[]>> = fc.dictionary(
  metricNameArb,
  fc.array(sampleArb, { minLength: 0, maxLength: 20 }),
  { minKeys: 0, maxKeys: 5 },
);

const optsArb: fc.Arbitrary<RuleOptions> = fc.record({
  baselineWindowMs: fc.integer({ min: 1000, max: 2_000_000 }),
  deviationSigma: fc.double({ min: 0.5, max: 5, noNaN: true }),
  correlationWindowMs: fc.integer({ min: 0, max: MAX_CORRELATION_WINDOW_MS + 1000 }),
});

// ---------------------------------------------------------------------------
// Independent oracle — mirrors the spec (design.md rules.ts / Requirement 10),
// NOT the module implementation.
// ---------------------------------------------------------------------------

function oracleSeverity(band: Band): number {
  if (band === "green") return 0;
  if (band === "yellow") return 1;
  if (band === "red") return 2;
  return -1; // unknown
}

/** Classify a value using half-open [min, max) bands; unknown if outside all. */
function oracleClassify(t: MetricThreshold, value: number): Band {
  if (value >= t.green.min && value < t.green.max) return "green";
  if (value >= t.yellow.min && value < t.yellow.max) return "yellow";
  if (value >= t.red.min && value < t.red.max) return "red";
  return "unknown";
}

function oracleCycleTMs(current: Record<string, Sample>): number {
  let max = 0;
  let seen = false;
  for (const m of Object.keys(current)) {
    const t = current[m].tMs;
    if (!seen || t > max) {
      max = t;
      seen = true;
    }
  }
  return seen ? max : 0;
}

function clampCorrelationWindow(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_CORRELATION_WINDOW_MS;
  return Math.min(MAX_CORRELATION_WINDOW_MS, Math.max(MIN_CORRELATION_WINDOW_MS, ms));
}

interface OracleCrossing {
  metric: string;
  from: Band;
  to: Band;
  tMs: number;
}

function oracleCrossings(
  current: Record<string, Sample>,
  previousBands: Record<string, Band>,
  cfg: ThresholdConfig,
): { crossings: OracleCrossing[]; unmonitored: Set<string> } {
  const crossings: OracleCrossing[] = [];
  const unmonitored = new Set<string>();

  for (const metric of Object.keys(current)) {
    const sample = current[metric];
    const hasConfig = !!cfg?.metrics?.[metric];
    if (!hasConfig) {
      unmonitored.add(metric);
      continue;
    }
    const to = oracleClassify(cfg.metrics[metric], sample.value);
    const from = previousBands[metric] ?? "unknown";
    if (oracleSeverity(to) > oracleSeverity(from)) {
      crossings.push({ metric, from, to, tMs: sample.tMs });
    }
  }
  return { crossings, unmonitored };
}

function oracleMean(vals: number[]): number {
  if (vals.length === 0) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function oracleStdDev(vals: number[], m: number): number {
  if (vals.length < 2) return 0;
  let acc = 0;
  for (const v of vals) acc += (v - m) * (v - m);
  return Math.sqrt(acc / vals.length);
}

function oracleSpikes(
  current: Record<string, Sample>,
  baselines: Record<string, Sample[]>,
  cycleTMs: number,
  baselineWindowMs: number,
  deviationSigma: number,
): Set<string> {
  // A spike is uniquely identified by its metric (one current sample per
  // metric), so a set of metric names is a faithful representation.
  const spikes = new Set<string>();
  for (const metric of Object.keys(current)) {
    const sample = current[metric];
    const history = baselines[metric] ?? [];
    const windowValues: number[] = [];
    for (const s of history) {
      const dt = cycleTMs - s.tMs;
      if (dt <= baselineWindowMs && dt >= 0) windowValues.push(s.value);
    }
    if (windowValues.length === 0) continue;
    const m = oracleMean(windowValues);
    const sd = oracleStdDev(windowValues, m);
    if (sd === 0) continue;
    if (Math.abs(sample.value - m) > deviationSigma * sd) spikes.add(metric);
  }
  return spikes;
}

/** Unordered metric-pair key for a correlation. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function oracleCorrelations(
  crossings: OracleCrossing[],
  correlationWindowMs: number,
): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < crossings.length; i++) {
    for (let j = i + 1; j < crossings.length; j++) {
      const a = crossings[i];
      const b = crossings[j];
      if (a.metric === b.metric) continue;
      const gap = Math.abs(a.tMs - b.tMs);
      if (gap <= correlationWindowMs) out.add(pairKey(a.metric, b.metric));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Property 9: Structured summary completeness
// ---------------------------------------------------------------------------

describe("Property 9: Structured summary completeness", () => {
  // Feature: personal-ai-apm-system, Property 9: Structured summary completeness
  it("summary reports exactly the independently re-derived findings and is empty iff none were found", () => {
    fc.assert(
      fc.property(
        currentArb,
        previousBandsArb,
        baselinesArb,
        thresholdConfigArb,
        // Sometimes use defaults (undefined opts), sometimes explicit opts.
        fc.option(optsArb, { nil: undefined }),
        (current, previousBands, baselines, cfg, maybeOpts) => {
          const opts = maybeOpts ?? {};
          const summary = analyze(current, previousBands, baselines, cfg, opts);

          // Re-derive with resolved parameters mirroring analyze's defaults.
          const cycleTMs = oracleCycleTMs(current);
          const baselineWindowMs = opts.baselineWindowMs ?? DEFAULT_BASELINE_WINDOW_MS;
          const deviationSigma = opts.deviationSigma ?? DEFAULT_DEVIATION_SIGMA;
          const correlationWindowMs = clampCorrelationWindow(
            opts.correlationWindowMs ?? DEFAULT_CORRELATION_WINDOW_MS,
          );

          const { crossings: oCrossings, unmonitored: oUnmonitored } =
            oracleCrossings(current, previousBands, cfg);
          const oSpikes = oracleSpikes(
            current,
            baselines,
            cycleTMs,
            baselineWindowMs,
            deviationSigma,
          );
          const oCorrelations = oracleCorrelations(oCrossings, correlationWindowMs);

          // Cycle timestamp is stamped correctly.
          expect(summary.cycleTMs).toBe(cycleTMs);

          // --- Band crossings: same set, no extras, no omissions. ---
          const expectedCrossKeys = oCrossings
            .map((c) => `${c.metric}:${c.from}->${c.to}@${c.tMs}`)
            .sort();
          const actualCrossKeys = summary.bandCrossings
            .map((c) => `${c.metric}:${c.from}->${c.to}@${c.tMs}`)
            .sort();
          expect(actualCrossKeys).toEqual(expectedCrossKeys);

          // Every reported crossing is a genuine higher-severity transition.
          for (const c of summary.bandCrossings) {
            expect(oracleSeverity(c.to)).toBeGreaterThan(oracleSeverity(c.from));
          }

          // --- Spikes: same set of metrics. ---
          const actualSpikeMetrics = summary.spikes.map((s) => s.metric).sort();
          expect(actualSpikeMetrics).toEqual([...oSpikes].sort());
          // No duplicate spike per metric.
          expect(new Set(actualSpikeMetrics).size).toBe(actualSpikeMetrics.length);

          // --- Correlations: same set of unordered pairs. ---
          const actualCorrKeys = summary.correlations
            .map((c) => pairKey(c.metricA, c.metricB))
            .sort();
          expect(actualCorrKeys).toEqual([...oCorrelations].sort());

          // --- Unmonitored: same set of metrics. ---
          expect([...summary.unmonitored].sort()).toEqual([...oUnmonitored].sort());

          // --- empty flag iff no findings across all three detectors. ---
          const anyFinding =
            summary.bandCrossings.length > 0 ||
            summary.spikes.length > 0 ||
            summary.correlations.length > 0;
          expect(summary.empty).toBe(!anyFinding);

          // The oracle's emptiness must agree with the summary's.
          const oracleEmpty =
            oCrossings.length === 0 &&
            oSpikes.size === 0 &&
            oCorrelations.size === 0;
          expect(summary.empty).toBe(oracleEmpty);
        },
      ),
      { numRuns: RUNS },
    );
  });

  // Feature: personal-ai-apm-system, Property 9: Structured summary completeness
  it("a correlation implies both of its metrics appear among the reported band crossings", () => {
    fc.assert(
      fc.property(
        currentArb,
        previousBandsArb,
        baselinesArb,
        thresholdConfigArb,
        fc.option(optsArb, { nil: undefined }),
        (current, previousBands, baselines, cfg, maybeOpts) => {
          const summary = analyze(current, previousBands, baselines, cfg, maybeOpts ?? {});
          const crossedMetrics = new Set(summary.bandCrossings.map((c) => c.metric));
          for (const corr of summary.correlations) {
            // Completeness includes internal consistency: a reported
            // correlation must be backed by two distinct reported crossings.
            expect(corr.metricA).not.toBe(corr.metricB);
            expect(crossedMetrics.has(corr.metricA)).toBe(true);
            expect(crossedMetrics.has(corr.metricB)).toBe(true);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});
