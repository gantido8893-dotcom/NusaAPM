// rules.ts — tier-1 rule-based analysis (always-on, instant, free).
//
// The first of the two AI-insight tiers (design.md "rules.ts — tier-1
// rule-based analysis", Requirement 10). It runs every cycle, needs no network
// or LLM call, and produces a `StructuredSummary` of everything worth escalating
// to the (rate-limited, occasional) LLM tier. The summary it returns is the ONLY
// payload ever handed to the LLM — never the raw time series (Requirement 11.2).
//
// Three independent detectors run over the current cycle's samples:
//
//   1. Band-crossing (Requirements 10.1, 10.2): a metric whose current value
//      classifies into a HIGHER-severity band than its previous band
//      (green -> yellow, yellow -> red, or green -> red) is recorded with its
//      prior and new band. A metric with no threshold config is skipped for
//      crossing detection and listed in `unmonitored`, without halting analysis
//      of the other metrics.
//   2. Spike (Requirement 10.3): a value that deviates from the mean of its
//      recent baseline window by more than the configured deviation (default
//      3 standard deviations over a default 15-minute window) is recorded.
//   3. Correlation (Requirement 10.4): whenever two metrics each cross into a
//      higher-severity band within the configured correlation window (default
//      60s, clamped to the 1s..3600s range), the pair is recorded.
//
// When no detector finds anything the summary is returned with `empty: true`
// (Requirement 10.5).
//
// This module is pure: given the same inputs it always returns the same
// `StructuredSummary`, which makes it directly property-testable (tasks 7.2 and
// 7.3 own the tests; this task implements only the logic).
//
// Requirements: 10.1, 10.2, 10.3, 10.4, 10.5

import { classify } from "./thresholds.js";
import type {
  Band,
  BandCrossing,
  Correlation,
  Sample,
  SpikeEvent,
  StructuredSummary,
  ThresholdConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Options and defaults
// ---------------------------------------------------------------------------

/** Baseline window default: 15 minutes (Requirement 10.3). */
export const DEFAULT_BASELINE_WINDOW_MS = 15 * 60 * 1000;

/** Spike deviation default: 3 standard deviations (Requirement 10.3). */
export const DEFAULT_DEVIATION_SIGMA = 3;

/** Correlation window default: 60 seconds (Requirement 10.4). */
export const DEFAULT_CORRELATION_WINDOW_MS = 60 * 1000;

/** Correlation window lower bound: 1 second (Requirement 10.4). */
export const MIN_CORRELATION_WINDOW_MS = 1 * 1000;

/** Correlation window upper bound: 3600 seconds (Requirement 10.4). */
export const MAX_CORRELATION_WINDOW_MS = 3600 * 1000;

/**
 * Tunable knobs for {@link analyze}. Every field is optional; omitted fields
 * fall back to the documented defaults from Requirement 10.
 */
export interface RuleOptions {
  /**
   * Length of the recent baseline window used for spike detection, in
   * milliseconds. Only baseline samples with `tMs` within this window of the
   * cycle time are considered. Default {@link DEFAULT_BASELINE_WINDOW_MS}
   * (15 minutes).
   */
  baselineWindowMs?: number;

  /**
   * Number of standard deviations a value must be away from its baseline-window
   * mean to count as a spike. Default {@link DEFAULT_DEVIATION_SIGMA} (3).
   */
  deviationSigma?: number;

  /**
   * Maximum time between two higher-severity band crossings for them to be
   * treated as correlated, in milliseconds. Clamped to the
   * {@link MIN_CORRELATION_WINDOW_MS}..{@link MAX_CORRELATION_WINDOW_MS} range.
   * Default {@link DEFAULT_CORRELATION_WINDOW_MS} (60 seconds).
   */
  correlationWindowMs?: number;
}

// ---------------------------------------------------------------------------
// Severity ordering
// ---------------------------------------------------------------------------

/**
 * Severity rank for a band. Higher is worse: green < yellow < red. `unknown`
 * has no defined severity and is treated as rank -1 so that neither entering
 * nor leaving it is ever mistaken for a higher-severity crossing.
 */
function severity(band: Band): number {
  switch (band) {
    case "green":
      return 0;
    case "yellow":
      return 1;
    case "red":
      return 2;
    default:
      return -1; // unknown
  }
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/**
 * Detect metrics that crossed into a higher-severity band this cycle.
 *
 * For each current sample:
 *   - If the metric has no threshold config, it is skipped for crossing
 *     detection and its name is collected into `unmonitored` (Requirement 10.2).
 *   - Otherwise it is classified into a band. When that band is strictly more
 *     severe than the metric's previous band, a {@link BandCrossing} is
 *     recorded carrying the prior band, the new band, and the sample time
 *     (Requirement 10.1).
 *
 * A metric that is `unknown` before or after (e.g. its value is outside all
 * bands) never yields a crossing, because `unknown` has no severity.
 */
function detectBandCrossings(
  current: Record<string, Sample>,
  previousBands: Record<string, Band>,
  cfg: ThresholdConfig,
): { crossings: BandCrossing[]; unmonitored: string[] } {
  const crossings: BandCrossing[] = [];
  const unmonitored: string[] = [];

  for (const metric of Object.keys(current)) {
    const sample = current[metric];
    const hasConfig = !!cfg?.metrics?.[metric];

    if (!hasConfig) {
      // No band config: skip crossing detection, note it, keep going.
      unmonitored.push(metric);
      continue;
    }

    const to = classify(cfg, metric, sample.value);
    const from = previousBands[metric] ?? "unknown";

    if (severity(to) > severity(from)) {
      crossings.push({ metric, from, to, tMs: sample.tMs });
    }
  }

  return { crossings, unmonitored };
}

/** Mean of a numeric array (0 for an empty array). */
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * Population standard deviation of a numeric array (0 for fewer than two
 * values). Population (divide by N) is used because the baseline window is the
 * full set of observations under consideration, not a sample of a larger set.
 */
function stdDev(values: number[], m: number): number {
  if (values.length < 2) return 0;
  let acc = 0;
  for (const v of values) {
    const d = v - m;
    acc += d * d;
  }
  return Math.sqrt(acc / values.length);
}

/**
 * Detect spikes: current values that deviate from their baseline-window mean by
 * more than `deviationSigma` standard deviations (Requirement 10.3).
 *
 * Baseline samples are filtered to those within `baselineWindowMs` of the
 * cycle time before computing the window mean and standard deviation. A metric
 * with no usable baseline (empty window) or a zero-variance window (stdDev 0)
 * cannot produce a statistically meaningful spike and is skipped — a flat
 * baseline offers no deviation to exceed.
 */
function detectSpikes(
  current: Record<string, Sample>,
  baselines: Record<string, Sample[]>,
  cycleTMs: number,
  baselineWindowMs: number,
  deviationSigma: number,
): SpikeEvent[] {
  const spikes: SpikeEvent[] = [];

  for (const metric of Object.keys(current)) {
    const sample = current[metric];
    const history = baselines[metric] ?? [];

    // Keep only baseline samples inside the recent window.
    const windowValues: number[] = [];
    for (const s of history) {
      if (cycleTMs - s.tMs <= baselineWindowMs && cycleTMs - s.tMs >= 0) {
        windowValues.push(s.value);
      }
    }

    if (windowValues.length === 0) continue;

    const m = mean(windowValues);
    const sd = stdDev(windowValues, m);

    // A zero-variance baseline has no spread to deviate from.
    if (sd === 0) continue;

    const deviation = Math.abs(sample.value - m);
    if (deviation > deviationSigma * sd) {
      spikes.push({ metric, value: sample.value, mean: m, stdDev: sd, tMs: sample.tMs });
    }
  }

  return spikes;
}

/**
 * Detect correlations between higher-severity band crossings (Requirement
 * 10.4). Any two distinct crossings whose sample times fall within
 * `correlationWindowMs` of each other are recorded as a correlated pair, with
 * `withinMs` set to the actual time gap between them. Each unordered pair is
 * emitted at most once.
 */
function detectCorrelations(
  crossings: BandCrossing[],
  correlationWindowMs: number,
): Correlation[] {
  const correlations: Correlation[] = [];

  for (let i = 0; i < crossings.length; i++) {
    for (let j = i + 1; j < crossings.length; j++) {
      const a = crossings[i];
      const b = crossings[j];
      if (a.metric === b.metric) continue;
      const gap = Math.abs(a.tMs - b.tMs);
      if (gap <= correlationWindowMs) {
        correlations.push({ metricA: a.metric, metricB: b.metric, withinMs: gap });
      }
    }
  }

  return correlations;
}

/**
 * The cycle's reference timestamp: the latest `tMs` among the current samples,
 * or 0 when there are none. Used both to stamp the summary and to anchor the
 * spike baseline window.
 */
function deriveCycleTMs(current: Record<string, Sample>): number {
  let max = 0;
  let seen = false;
  for (const metric of Object.keys(current)) {
    const t = current[metric].tMs;
    if (!seen || t > max) {
      max = t;
      seen = true;
    }
  }
  return seen ? max : 0;
}

/** Clamp a correlation window to the allowed 1s..3600s range. */
function clampCorrelationWindow(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_CORRELATION_WINDOW_MS;
  return Math.min(MAX_CORRELATION_WINDOW_MS, Math.max(MIN_CORRELATION_WINDOW_MS, ms));
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run the tier-1 rule-based analysis for one insight cycle (Requirement 10).
 *
 * @param current       The latest sample per metric this cycle.
 * @param previousBands The band each metric was in before this cycle, used to
 *                      detect higher-severity crossings. A metric absent here is
 *                      treated as previously `unknown`.
 * @param baselines     Recent samples per metric for spike detection; only those
 *                      inside the baseline window are used.
 * @param cfg           Threshold config; metrics missing from it are reported as
 *                      `unmonitored` and skipped for crossing detection.
 * @param opts          Optional tuning knobs (window sizes, deviation sigma).
 * @returns A {@link StructuredSummary} of all findings, with `empty: true` when
 *          no band crossing, spike, or correlation was detected.
 *
 * The cycle timestamp stamped onto the summary (and used as the reference point
 * for the spike baseline window) is the latest `tMs` among the current samples,
 * so `analyze` keeps the design's `(current, previousBands, baselines, cfg,
 * opts)` signature without a separate clock parameter. When there are no
 * current samples it is 0.
 */
export function analyze(
  current: Record<string, Sample>,
  previousBands: Record<string, Band>,
  baselines: Record<string, Sample[]>,
  cfg: ThresholdConfig,
  opts: RuleOptions = {},
): StructuredSummary {
  const cycleTMs = deriveCycleTMs(current);
  const baselineWindowMs = opts.baselineWindowMs ?? DEFAULT_BASELINE_WINDOW_MS;
  const deviationSigma = opts.deviationSigma ?? DEFAULT_DEVIATION_SIGMA;
  const correlationWindowMs = clampCorrelationWindow(
    opts.correlationWindowMs ?? DEFAULT_CORRELATION_WINDOW_MS,
  );

  const { crossings, unmonitored } = detectBandCrossings(current, previousBands, cfg);
  const spikes = detectSpikes(current, baselines, cycleTMs, baselineWindowMs, deviationSigma);
  const correlations = detectCorrelations(crossings, correlationWindowMs);

  const empty =
    crossings.length === 0 && spikes.length === 0 && correlations.length === 0;

  return {
    cycleTMs,
    bandCrossings: crossings,
    spikes,
    correlations,
    unmonitored,
    empty,
  };
}
