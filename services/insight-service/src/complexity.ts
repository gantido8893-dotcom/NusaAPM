// Empirical curve fitting for time and space complexity (task 5.3).
//
// Fits observed (load, value) pairs against candidate complexity classes and
// reports the best fit in plain language. The same function serves both time
// complexity ((Load_Level, p95 latency)) and space complexity ((data volume,
// memory RSS)) since both are ordinary (x, y) curve fits.
//
// See design.md ("complexity.ts — empirical curve fitting"). Algorithm:
//   1. Count distinct load levels; < 5 -> insufficient-data.
//   2. Transform x per candidate class and run OLS linear regression on the
//      transformed x (constant is the mean model).
//   3. Compute R^2 for each candidate.
//   4. Pick the highest R^2, breaking ties toward the simpler curve
//      (constant < logarithmic < linear < linearithmic < quadratic).
//   5. If best R^2 < minFitQuality (default 0.7) -> indeterminate.
//   6. Otherwise -> ok with class, R^2, and a plain-language description.
//
// Requirements: 6.2, 6.3, 6.4, 6.5, 7.2, 7.3, 7.4, 7.5

import type { ComplexityClass, ComplexityEstimate, FitInput } from "./types.js";

/** Minimum distinct load levels required before a fit is attempted. */
const MIN_DISTINCT_LOAD_LEVELS = 5;

/** Default minimum coefficient of determination for a usable fit. */
export const DEFAULT_MIN_FIT_QUALITY = 0.7;

/**
 * Candidate classes ordered simplest -> most complex. This ordering is the
 * tie-break preference: on equal R^2 the earlier (simpler) class wins.
 */
const CANDIDATE_ORDER: ComplexityClass[] = [
  "constant",
  "logarithmic",
  "linear",
  "linearithmic",
  "quadratic",
];

/**
 * Transform a raw load value into the regression x for a candidate class.
 * Returns `null` when the transform is undefined for this input (e.g. a
 * non-positive load fed to a logarithmic transform), which makes the whole
 * candidate unfittable.
 */
function transform(cls: ComplexityClass, load: number): number | null {
  switch (cls) {
    case "constant":
      // x is unused for the constant (mean) model; any finite value works.
      return 0;
    case "logarithmic":
      return load > 0 ? Math.log(load) : null;
    case "linear":
      return load;
    case "linearithmic":
      return load > 0 ? load * Math.log(load) : null;
    case "quadratic":
      return load * load;
  }
}

/** Plain-language scaling description for each complexity class. */
function describe(cls: ComplexityClass): string {
  switch (cls) {
    case "constant":
      return "stays roughly constant regardless of load";
    case "logarithmic":
      return "grows slowly (logarithmically) with load";
    case "linear":
      return "scales roughly linearly with load";
    case "linearithmic":
      return "grows a little faster than linearly (n log n) with load";
    case "quadratic":
      return "grows quadratically with load";
  }
}

/**
 * Coefficient of determination (R^2) of an ordinary least-squares linear fit
 * `y = a + b * x`, or of the constant mean model when `constantModel` is set.
 *
 * Returns `null` when the fit cannot be computed (any transform failed, or the
 * response y has no variance so R^2 is undefined).
 */
function rSquaredFor(
  xs: readonly (number | null)[],
  ys: readonly number[],
  constantModel: boolean,
): number | null {
  const n = ys.length;

  // Total sum of squares around the mean of y.
  const meanY = ys.reduce((s, y) => s + y, 0) / n;
  const ssTot = ys.reduce((s, y) => s + (y - meanY) * (y - meanY), 0);

  // A flat response (no variance) has an undefined R^2 for a proper fit.
  if (ssTot === 0) {
    return null;
  }

  if (constantModel) {
    // The best constant predictor is the mean, giving zero explained variance
    // relative to the mean baseline: R^2 = 0.
    return 0;
  }

  // Every transformed x must be defined for this candidate to be fittable.
  const x: number[] = [];
  for (const value of xs) {
    if (value === null || !Number.isFinite(value)) {
      return null;
    }
    x.push(value);
  }

  const meanX = x.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    sxx += dx * dx;
    sxy += dx * (ys[i] - meanY);
  }

  // Degenerate predictor: transformed x is constant, so slope is undefined.
  if (sxx === 0) {
    return null;
  }

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const predicted = intercept + slope * x[i];
    const residual = ys[i] - predicted;
    ssRes += residual * residual;
  }

  const r2 = 1 - ssRes / ssTot;
  // Clamp tiny negative values from floating-point noise up to 0.
  return r2 < 0 ? 0 : r2;
}

/**
 * Estimate the empirical complexity class that best fits `pairs`.
 *
 * @param pairs         `(load, value)` observations (latency or memory RSS).
 * @param minFitQuality Minimum R^2 for a usable fit (default 0.7); below this
 *                      the result is `indeterminate`.
 */
export function estimateComplexity(
  pairs: FitInput[],
  minFitQuality: number = DEFAULT_MIN_FIT_QUALITY,
): ComplexityEstimate {
  const distinctLoadLevels = new Set(pairs.map((p) => p.load)).size;

  // Step 1: need at least 5 distinct load levels to attempt a fit.
  if (distinctLoadLevels < MIN_DISTINCT_LOAD_LEVELS) {
    return { status: "insufficient-data", distinctLoadLevels };
  }

  const ys = pairs.map((p) => p.value);

  // Steps 2-4: fit each candidate and pick the highest R^2, preferring the
  // simpler curve on ties. Iterating in simplest-first order and using a
  // strict `>` comparison naturally keeps the simpler class on a tie.
  let bestClass: ComplexityClass | null = null;
  let bestR2 = Number.NEGATIVE_INFINITY;

  for (const cls of CANDIDATE_ORDER) {
    const xs = pairs.map((p) => transform(cls, p.load));
    const r2 = rSquaredFor(xs, ys, cls === "constant");
    if (r2 === null) {
      continue;
    }
    if (r2 > bestR2) {
      bestR2 = r2;
      bestClass = cls;
    }
  }

  // No candidate could be fitted (e.g. flat response with zero variance).
  if (bestClass === null) {
    return { status: "indeterminate", distinctLoadLevels };
  }

  // Step 5: enforce the minimum fit quality floor.
  if (bestR2 < minFitQuality) {
    return { status: "indeterminate", distinctLoadLevels, rSquared: bestR2 };
  }

  // Step 6: usable fit.
  return {
    status: "ok",
    complexityClass: bestClass,
    plainLanguage: describe(bestClass),
    rSquared: bestR2,
    distinctLoadLevels,
  };
}
