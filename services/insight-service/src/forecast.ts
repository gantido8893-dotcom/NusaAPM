// forecast.ts — linear trend fitting and runway-to-critical estimation.
//
// Estimates how long, at the current trend, until a tracked metric crosses into
// its Critical_Range (Red_Band). The approach is deliberately simple and
// empirical (design.md "forecast.ts", Requirement 8):
//
//   1. Filter the metric's history to a configurable lookback window
//      (1h..30d, default 7d) (Requirement 8.1).
//   2. If fewer than 10 points fall inside that window, return
//      `insufficient-data`; the caller retains any previously reported estimate
//      unchanged (Requirement 8.4).
//   3. Fit a linear trend `value = slope * t + intercept` by ordinary least
//      squares over the in-window points.
//   4. Solve for the time `t*` at which the fitted line reaches `redBandStart`.
//      If that crossing is in the past, moves away from the red band (wrong
//      direction, including a flat/zero-slope trend), or lies beyond the
//      extrapolation horizon, the metric is `not-trending` (Requirement 8.3).
//   5. Otherwise return `ok` with `timeToCriticalMs` and a whole-hours-or-days
//      human-readable string (Requirement 8.2).
//
// This module is pure: given the same `ForecastInput` it always returns the
// same `RunwayEstimate`, which makes it directly property-testable (tasks
// 5.9-5.11 own the tests; this task implements only the logic).
//
// Requirements: 8.1, 8.2, 8.3, 8.4

import type { ForecastInput, RunwayEstimate, Sample } from "./types.js";

/** Lookback-window bounds from Requirement 8.1 (1 hour .. 30 days). */
export const MIN_LOOKBACK_MS = 60 * 60 * 1000; // 1 hour
export const MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Minimum in-window points required to fit a trend (Requirement 8.4). */
export const MIN_DATA_POINTS = 10;

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Estimate the runway (time-to-critical) for a single tracked metric.
 *
 * See the module header for the full algorithm. The returned `dataPoints`
 * always reflects the number of samples that fell inside the lookback window,
 * regardless of status, so callers can surface it in the JSON API.
 */
export function estimateRunway(input: ForecastInput): RunwayEstimate {
  const { history, redBandStart, horizonMs, approachFromBelow } = input;

  // Clamp the lookback window into its allowed [1h, 30d] range (R8.1). An
  // unspecified/invalid window falls back to the 7-day default.
  const lookbackMs = clampLookback(input.lookbackMs);

  // Filter to the lookback window relative to the most recent sample. With no
  // samples there is nothing to anchor the window to.
  const inWindow = filterToWindow(history, lookbackMs);
  const dataPoints = inWindow.length;

  // R8.4: fewer than 10 in-window points -> insufficient-data. The caller
  // retains any previously reported estimate unchanged.
  if (dataPoints < MIN_DATA_POINTS) {
    return { status: "insufficient-data", dataPoints };
  }

  const fit = leastSquaresFit(inWindow);

  // A degenerate fit (all samples share the same timestamp) has no defined
  // slope, so no trend can be extrapolated.
  if (fit === undefined) {
    return { status: "not-trending", slopePerMs: 0, dataPoints };
  }

  const { slope, intercept } = fit;

  // Direction check (R8.3). `approachFromBelow` means a *rising* value crosses
  // into the red band, so the trend must have a positive slope; otherwise it
  // must be falling. A flat (zero-slope) trend never reaches the threshold.
  const movingTowardRed = approachFromBelow ? slope > 0 : slope < 0;
  if (!movingTowardRed) {
    return { status: "not-trending", slopePerMs: slope, dataPoints };
  }

  // Solve `redBandStart = slope * tCross + intercept` for the crossing time.
  const tCross = (redBandStart - intercept) / slope;

  // Extrapolate forward from the most recent sample.
  const nowMs = inWindow[inWindow.length - 1]!.tMs;
  const timeToCriticalMs = tCross - nowMs;

  // R8.3: a crossing already in the past, or one beyond the horizon, means the
  // metric is not trending into critical within the window we care about.
  if (timeToCriticalMs < 0 || timeToCriticalMs > horizonMs) {
    return { status: "not-trending", slopePerMs: slope, dataPoints };
  }

  // R8.2: report the estimate in whole hours or days.
  return {
    status: "ok",
    timeToCriticalMs,
    humanReadable: humanizeDuration(timeToCriticalMs),
    slopePerMs: slope,
    dataPoints,
  };
}

/** Clamp a requested lookback window into [1h, 30d], defaulting to 7d. */
function clampLookback(requestedMs: number | undefined): number {
  if (requestedMs === undefined || !Number.isFinite(requestedMs)) {
    return DEFAULT_LOOKBACK_MS;
  }
  if (requestedMs < MIN_LOOKBACK_MS) return MIN_LOOKBACK_MS;
  if (requestedMs > MAX_LOOKBACK_MS) return MAX_LOOKBACK_MS;
  return requestedMs;
}

/**
 * Return the samples whose timestamp falls within `lookbackMs` of the most
 * recent sample, i.e. `[latest - lookbackMs, latest]`. The window is anchored
 * to the newest observation so the fit reflects the metric's recent behavior
 * (Requirement 8.1).
 */
function filterToWindow(history: Sample[], lookbackMs: number): Sample[] {
  if (history.length === 0) return [];
  let latest = -Infinity;
  for (const s of history) {
    if (s.tMs > latest) latest = s.tMs;
  }
  const cutoff = latest - lookbackMs;
  return history.filter((s) => s.tMs >= cutoff);
}

/**
 * Ordinary least-squares fit of `value = slope * t + intercept` over the given
 * samples. Returns `undefined` when the slope is undefined because all samples
 * share the same timestamp (zero variance in t).
 */
function leastSquaresFit(
  samples: Sample[],
): { slope: number; intercept: number } | undefined {
  const n = samples.length;
  let sumT = 0;
  let sumV = 0;
  for (const s of samples) {
    sumT += s.tMs;
    sumV += s.value;
  }
  const meanT = sumT / n;
  const meanV = sumV / n;

  let sTT = 0; // sum of (t - meanT)^2
  let sTV = 0; // sum of (t - meanT)(v - meanV)
  for (const s of samples) {
    const dt = s.tMs - meanT;
    sTT += dt * dt;
    sTV += dt * (s.value - meanV);
  }

  if (sTT === 0) return undefined; // no spread in time -> slope undefined
  const slope = sTV / sTT;
  const intercept = meanV - slope * meanT;
  return { slope, intercept };
}

/**
 * Render a positive duration as a whole-hours-or-days string (Requirement 8.2).
 * Durations of a day or more are reported in whole days; shorter ones in whole
 * hours. Sub-hour durations round up to at least one hour so the estimate is
 * never reported as "~0 hours".
 */
export function humanizeDuration(ms: number): string {
  if (ms >= MS_PER_DAY) {
    const days = Math.round(ms / MS_PER_DAY);
    return `~${days} ${days === 1 ? "day" : "days"}`;
  }
  const hours = Math.max(1, Math.round(ms / MS_PER_HOUR));
  return `~${hours} ${hours === 1 ? "hour" : "hours"}`;
}
