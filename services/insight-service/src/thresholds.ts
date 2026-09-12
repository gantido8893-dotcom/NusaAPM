// Threshold band configuration and classification (thresholds.ts).
//
// Owns the green/yellow/red band config and classification logic for the
// Insight Service (design.md "thresholds.ts — band configuration and
// classification", "Data Models", and Requirement 3). Bands are half-open
// ranges `[min, max)`: a value equal to a band's `min` belongs to that band,
// a value equal to its `max` belongs to the next band up.
//
// Cross-module data models (Band, BandRange, MetricThreshold, ThresholdConfig)
// are imported from ./types — this module does NOT redefine them. Only the
// result/holder types local to threshold validation and hot-reload live here.
//
// Requirements: 2.6, 2.8, 3.1, 3.2, 3.3, 3.4, 3.5

import type {
  Band,
  BandRange,
  MetricThreshold,
  ThresholdConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

/**
 * Outcome of validating a {@link MetricThreshold}. When `valid` is false,
 * `errors` identifies the invalid band definition(s) so the caller can surface
 * an indication and reject the change while retaining the prior config
 * (Requirement 3.4).
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** True when a range is a finite, well-formed half-open interval `[min, max)`. */
function isWellFormedRange(r: BandRange | undefined): r is BandRange {
  return (
    !!r &&
    typeof r.min === "number" &&
    typeof r.max === "number" &&
    Number.isFinite(r.min) &&
    Number.isFinite(r.max) &&
    r.min < r.max
  );
}

/**
 * Validate a metric's green/yellow/red bands.
 *
 * A config is accepted if and only if all three bands are present, each is a
 * well-formed half-open range, and the three bands are contiguous,
 * non-overlapping, and gap-free — jointly covering `[overallMin, overallMax)`
 * with no gaps (Requirements 3.1, 3.4). Any overlap, gap, or missing/malformed
 * band is rejected with an identifying error.
 *
 * Order-independent: the three bands may be supplied in any numeric order
 * (e.g. a metric where "red" is a low value and "green" a high value). What
 * matters is that, once sorted, they abut exactly with no gap or overlap.
 */
export function validateThreshold(t: MetricThreshold): ValidationResult {
  const errors: string[] = [];

  if (!t || typeof t !== "object") {
    return { valid: false, errors: ["threshold config is missing"] };
  }

  const named: Array<{ name: keyof MetricThreshold & string; range: BandRange | undefined }> = [
    { name: "green", range: t.green },
    { name: "yellow", range: t.yellow },
    { name: "red", range: t.red },
  ];

  // All three bands must be present and well-formed.
  for (const { name, range } of named) {
    if (!range) {
      errors.push(`missing ${name} band`);
    } else if (!isWellFormedRange(range)) {
      errors.push(`${name} band is not a well-formed half-open range [min, max) with min < max`);
    }
  }

  // If any band is missing/malformed we cannot meaningfully check contiguity.
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Sort the three bands by their lower bound to check contiguity/coverage
  // independent of the order the caller declared them in.
  const sorted = [...named].sort((a, b) => a.range!.min - b.range!.min);

  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i].range!;
    const next = sorted[i + 1].range!;
    if (cur.max > next.min) {
      errors.push(
        `bands ${sorted[i].name} and ${sorted[i + 1].name} overlap ([${cur.min}, ${cur.max}) and [${next.min}, ${next.max}))`,
      );
    } else if (cur.max < next.min) {
      errors.push(
        `gap between bands ${sorted[i].name} and ${sorted[i + 1].name} ([${cur.max}, ${next.min}) is uncovered)`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** True when `value` falls in the half-open range `[r.min, r.max)`. */
function inRange(value: number, r: BandRange): boolean {
  return value >= r.min && value < r.max;
}

/**
 * Classify a raw value against a single (already validated) metric threshold.
 * Returns exactly one of `green` / `yellow` / `red`, or `unknown` when the
 * value lies outside every band. Bands are half-open `[min, max)`.
 */
function classifyValue(t: MetricThreshold, value: number): Band {
  if (!Number.isFinite(value)) return "unknown";
  if (inRange(value, t.green)) return "green";
  if (inRange(value, t.yellow)) return "yellow";
  if (inRange(value, t.red)) return "red";
  return "unknown";
}

/**
 * Classify a tracked metric's current value into exactly one band, or
 * `unknown` (Requirements 3.2, 3.3).
 *
 * Returns `unknown` when:
 *   - the metric has no entry in the config,
 *   - the metric's configured threshold is invalid, or
 *   - the value lies outside all defined bands (or is not finite).
 *
 * Retaining the last known band on a missing/invalid config is handled by
 * {@link ThresholdStore.classify}, which owns the last-known-band state; this
 * pure function reports only what the config alone determines.
 */
export function classify(cfg: ThresholdConfig, metric: string, value: number): Band {
  const t = cfg?.metrics?.[metric];
  if (!t) return "unknown";
  if (!validateThreshold(t).valid) return "unknown";
  return classifyValue(t, value);
}

// ---------------------------------------------------------------------------
// Percentage of critical
// ---------------------------------------------------------------------------

/**
 * Percentage of the critical (red) threshold currently in use (Requirements
 * 2.6, 2.8). Returns a number when a well-formed red (Critical_Range) band is
 * configured, and `undefined` when it is not — signalling to the caller that
 * the metric lacks a configured critical threshold.
 *
 * The critical threshold is the lower bound at which the red band begins
 * (`red.min`). The percentage is `value / red.min * 100`, so 100% means the
 * value has reached the critical threshold. When `red.min` is 0 the ratio is
 * undefined mathematically, so the boundary is treated as reached: 100% for a
 * non-negative value at/above it, 0% for a value below it.
 */
export function percentOfCritical(t: MetricThreshold, value: number): number | undefined {
  if (!t || !isWellFormedRange(t.red)) return undefined;
  if (!Number.isFinite(value)) return undefined;

  const criticalStart = t.red.min;
  if (criticalStart === 0) {
    return value >= 0 ? 100 : 0;
  }
  return (value / criticalStart) * 100;
}

// ---------------------------------------------------------------------------
// In-memory hot-reloadable store
// ---------------------------------------------------------------------------

/**
 * In-memory holder for the active {@link ThresholdConfig} that supports
 * hot-reload: accepted config changes apply to all subsequent classifications
 * without a restart (Requirement 3.5). Rejected (invalid) changes are ignored
 * and the previously active config is retained (Requirement 3.4).
 *
 * The store also remembers, per metric, the last band it classified into so it
 * can retain that band when the config later goes missing/invalid or the value
 * falls outside all bands (Requirement 3.3).
 */
export class ThresholdStore {
  private config: ThresholdConfig;
  private lastKnownBand: Record<string, Band> = {};

  constructor(initial?: ThresholdConfig) {
    this.config = initial ?? { metrics: {} };
  }

  /** The currently active config (the last accepted one). */
  getConfig(): ThresholdConfig {
    return this.config;
  }

  /**
   * Attempt to replace the entire active config. Every metric threshold in the
   * proposed config must validate; if any is invalid the whole change is
   * rejected, the prior config is retained, and the identifying errors are
   * returned (Requirement 3.4). On success the new config applies immediately
   * to subsequent classifications with no restart (Requirement 3.5).
   */
  setConfig(next: ThresholdConfig): ValidationResult {
    if (!next || typeof next !== "object" || !next.metrics || typeof next.metrics !== "object") {
      return { valid: false, errors: ["config is missing a `metrics` map"] };
    }

    const errors: string[] = [];
    for (const [metric, threshold] of Object.entries(next.metrics)) {
      const result = validateThreshold(threshold);
      if (!result.valid) {
        errors.push(...result.errors.map((e) => `${metric}: ${e}`));
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    this.config = next;
    return { valid: true, errors: [] };
  }

  /**
   * Attempt to set/replace a single metric's threshold. The change is applied
   * only if it validates; otherwise the prior threshold for that metric is
   * retained (Requirements 3.4, 3.5).
   */
  setMetricThreshold(metric: string, threshold: MetricThreshold): ValidationResult {
    const result = validateThreshold(threshold);
    if (!result.valid) {
      return { valid: false, errors: result.errors.map((e) => `${metric}: ${e}`) };
    }
    this.config = {
      ...this.config,
      metrics: { ...this.config.metrics, [metric]: threshold },
    };
    return { valid: true, errors: [] };
  }

  /**
   * Classify the metric's current value using the active config. When the
   * config is missing/invalid or the value falls outside all bands, the last
   * known band for that metric is retained and returned instead of `unknown`
   * (Requirement 3.3). If there is no last known band, `unknown` is returned.
   * A definite band classification is remembered as the new last known band.
   */
  classify(metric: string, value: number): Band {
    const band = classify(this.config, metric, value);
    if (band !== "unknown") {
      this.lastKnownBand[metric] = band;
      return band;
    }
    // Missing/invalid config or out-of-range value: retain last known band.
    return this.lastKnownBand[metric] ?? "unknown";
  }

  /**
   * Percentage of the configured critical threshold in use for the metric, or
   * `undefined` when the metric has no config or no critical (red) band
   * (Requirements 2.6, 2.8).
   */
  percentOfCritical(metric: string, value: number): number | undefined {
    const t = this.config.metrics[metric];
    if (!t) return undefined;
    return percentOfCritical(t, value);
  }
}
