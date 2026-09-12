// Feature: personal-ai-apm-system
// Example-based unit tests for complexity.ts edge cases (task 5.7).
//
// Covers the boundary behaviours called out in design.md and the task:
//   - exactly 5 distinct load levels (boundary -> a fit is attempted)
//   - ties between curves resolve to the simpler class
//   - best R^2 just below / just above the 0.7 fit-quality floor
//
// Requirements: 6.3 (report best-fit class), 6.4 (indeterminate below floor),
// 6.5 (insufficient-data below 5 distinct load levels).

import { describe, it, expect } from "vitest";
import {
  estimateComplexity,
  DEFAULT_MIN_FIT_QUALITY,
} from "./complexity.js";
import type { FitInput } from "./types.js";

describe("estimateComplexity — distinct-load-level boundary (Requirement 6.5)", () => {
  it("returns insufficient-data with 4 distinct load levels", () => {
    // 4 distinct loads (one repeated) -> below the 5-level minimum.
    const pairs: FitInput[] = [
      { load: 1, value: 10 },
      { load: 2, value: 20 },
      { load: 3, value: 30 },
      { load: 4, value: 40 },
      { load: 4, value: 41 },
    ];
    const result = estimateComplexity(pairs);
    expect(result.status).toBe("insufficient-data");
    expect(result.distinctLoadLevels).toBe(4);
    expect(result.complexityClass).toBeUndefined();
  });

  it("attempts a fit at exactly 5 distinct load levels (boundary is inclusive)", () => {
    // Perfectly linear data across exactly 5 distinct loads.
    const pairs: FitInput[] = [
      { load: 1, value: 3 },
      { load: 2, value: 5 },
      { load: 3, value: 7 },
      { load: 4, value: 9 },
      { load: 5, value: 11 },
    ];
    const result = estimateComplexity(pairs);
    expect(result.distinctLoadLevels).toBe(5);
    // A fit was attempted, so it is not insufficient-data.
    expect(result.status).not.toBe("insufficient-data");
    expect(result.status).toBe("ok");
    expect(result.complexityClass).toBe("linear");
    expect(result.rSquared).toBeCloseTo(1, 9);
  });

  it("counts distinct loads even when there are 5 rows but fewer distinct loads", () => {
    const pairs: FitInput[] = [
      { load: 1, value: 3 },
      { load: 1, value: 4 },
      { load: 2, value: 5 },
      { load: 3, value: 7 },
      { load: 3, value: 8 },
    ];
    const result = estimateComplexity(pairs);
    expect(result.distinctLoadLevels).toBe(3);
    expect(result.status).toBe("insufficient-data");
  });
});

describe("estimateComplexity — ties resolve to the simpler class (Requirement 6.3)", () => {
  it("prefers constant when the response is a flat non-varying line ... has no variance -> indeterminate", () => {
    // A perfectly flat response has zero variance: every candidate is
    // unfittable (R^2 undefined), so the result is indeterminate.
    const pairs: FitInput[] = [
      { load: 1, value: 5 },
      { load: 2, value: 5 },
      { load: 3, value: 5 },
      { load: 4, value: 5 },
      { load: 5, value: 5 },
    ];
    const result = estimateComplexity(pairs);
    expect(result.status).toBe("indeterminate");
    expect(result.complexityClass).toBeUndefined();
  });

  it("prefers linear over quadratic when both fit perfectly (tie -> simpler wins)", () => {
    // Data lies exactly on a line. Both the linear and quadratic regressions
    // achieve R^2 = 1 (the quadratic term simply gets ~0 weight after fit on
    // this range), so the tie must resolve to the simpler class, linear.
    const pairs: FitInput[] = [
      { load: 1, value: 2 },
      { load: 2, value: 4 },
      { load: 3, value: 6 },
      { load: 4, value: 8 },
      { load: 5, value: 10 },
      { load: 6, value: 12 },
    ];
    const result = estimateComplexity(pairs);
    expect(result.status).toBe("ok");
    // Quadratic on these points also reaches R^2 = 1, but linear is simpler.
    expect(result.complexityClass).toBe("linear");
    expect(result.rSquared).toBeCloseTo(1, 9);
  });
});

describe("estimateComplexity — fit-quality floor boundary (Requirement 6.4)", () => {
  // Build a dataset whose best achievable R^2 is a known, controllable value by
  // taking perfectly linear data and perturbing a single point. We first
  // measure the resulting best R^2, then assert the floor behaviour by setting
  // minFitQuality just below and just above that measured value.
  const noisyLinear: FitInput[] = [
    { load: 1, value: 10 },
    { load: 2, value: 21 },
    { load: 3, value: 29 },
    { load: 4, value: 41 },
    { load: 5, value: 48 },
    { load: 6, value: 62 },
  ];

  it("returns ok when best R^2 is at/above the configured floor", () => {
    const measured = estimateComplexity(noisyLinear, 0).rSquared;
    expect(measured).toBeDefined();
    const r2 = measured as number;
    // R^2 must be strictly below 1 so the boundary test is meaningful.
    expect(r2).toBeLessThan(1);

    // Floor just below the achievable R^2 -> ok.
    const justBelow = estimateComplexity(noisyLinear, r2 - 1e-6);
    expect(justBelow.status).toBe("ok");
    expect(justBelow.complexityClass).toBe("linear");
    expect(justBelow.rSquared as number).toBeCloseTo(r2, 9);
  });

  it("returns indeterminate when best R^2 is below the configured floor", () => {
    const measured = estimateComplexity(noisyLinear, 0).rSquared;
    const r2 = measured as number;

    // Floor just above the achievable R^2 -> indeterminate.
    const justAbove = estimateComplexity(noisyLinear, r2 + 1e-6);
    expect(justAbove.status).toBe("indeterminate");
    expect(justAbove.complexityClass).toBeUndefined();
    // The near-miss R^2 is still reported for context.
    expect(justAbove.rSquared as number).toBeCloseTo(r2, 9);
  });

  it("uses the default 0.7 floor: strong linear data (R^2 >= 0.7) is ok", () => {
    const result = estimateComplexity(noisyLinear);
    // This near-linear dataset comfortably clears the default floor.
    expect(result.rSquared as number).toBeGreaterThanOrEqual(
      DEFAULT_MIN_FIT_QUALITY,
    );
    expect(result.status).toBe("ok");
    expect(result.complexityClass).toBe("linear");
  });

  it("uses the default 0.7 floor: weakly-correlated data is indeterminate", () => {
    // Scattered response with no real trend -> best R^2 below 0.7.
    const scattered: FitInput[] = [
      { load: 1, value: 50 },
      { load: 2, value: 12 },
      { load: 3, value: 47 },
      { load: 4, value: 9 },
      { load: 5, value: 44 },
      { load: 6, value: 15 },
    ];
    const result = estimateComplexity(scattered);
    expect(result.status).toBe("indeterminate");
    expect(result.rSquared as number).toBeLessThan(DEFAULT_MIN_FIT_QUALITY);
    expect(result.complexityClass).toBeUndefined();
  });
});
