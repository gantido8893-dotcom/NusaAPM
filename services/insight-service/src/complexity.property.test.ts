// Feature: personal-ai-apm-system
// Property-based tests for complexity.ts empirical curve fitting.
//
// Covers design.md Correctness Properties 4, 5, and 6 for
// `estimateComplexity` (tasks 5.4, 5.5, 5.6). All tests use fast-check with
// at least 100 iterations. No external I/O — the function is a pure numeric
// fit, so nothing is mocked.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  estimateComplexity,
  DEFAULT_MIN_FIT_QUALITY,
} from "./complexity.js";
import type { ComplexityClass, FitInput } from "./types.js";

const NUM_RUNS = 200;

const MIN_DISTINCT_LOAD_LEVELS = 5;

/** Candidate classes ordered simplest -> most complex (matches complexity.ts). */
const CANDIDATE_ORDER: ComplexityClass[] = [
  "constant",
  "logarithmic",
  "linear",
  "linearithmic",
  "quadratic",
];

/** Finite, well-scaled load/value values so fits stay numerically sane. */
const finiteValue = (): fc.Arbitrary<number> =>
  fc
    .double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true })
    .filter((v) => Number.isFinite(v));

/** A single (load, value) observation with a strictly positive load. */
const pairArb = (): fc.Arbitrary<FitInput> =>
  fc.record({
    load: fc
      .double({ min: 0.5, max: 1e5, noNaN: true, noDefaultInfinity: true })
      .filter((v) => Number.isFinite(v) && v > 0),
    value: finiteValue(),
  });

/**
 * Re-derive the transformed regression x used by complexity.ts, so the test's
 * expectations are computed independently of the implementation's internals.
 */
function transform(cls: ComplexityClass, load: number): number | null {
  switch (cls) {
    case "constant":
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

/** Independent R^2 computation mirroring complexity.ts (used as an oracle). */
function rSquaredFor(
  xs: readonly (number | null)[],
  ys: readonly number[],
  constantModel: boolean,
): number | null {
  const n = ys.length;
  const meanY = ys.reduce((s, y) => s + y, 0) / n;
  const ssTot = ys.reduce((s, y) => s + (y - meanY) * (y - meanY), 0);
  if (ssTot === 0) return null;
  if (constantModel) return 0;

  const x: number[] = [];
  for (const value of xs) {
    if (value === null || !Number.isFinite(value)) return null;
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
  if (sxx === 0) return null;

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const predicted = intercept + slope * x[i];
    const residual = ys[i] - predicted;
    ssRes += residual * residual;
  }
  const r2 = 1 - ssRes / ssTot;
  return r2 < 0 ? 0 : r2;
}

/** Best (class, R^2) computed independently, with simpler-curve tie-break. */
function bestFitOracle(
  pairs: FitInput[],
): { cls: ComplexityClass; r2: number } | null {
  const ys = pairs.map((p) => p.value);
  let bestClass: ComplexityClass | null = null;
  let bestR2 = Number.NEGATIVE_INFINITY;
  for (const cls of CANDIDATE_ORDER) {
    const xs = pairs.map((p) => transform(cls, p.load));
    const r2 = rSquaredFor(xs, ys, cls === "constant");
    if (r2 === null) continue;
    if (r2 > bestR2) {
      bestR2 = r2;
      bestClass = cls;
    }
  }
  return bestClass === null ? null : { cls: bestClass, r2: bestR2 };
}

function distinctLoadCount(pairs: FitInput[]): number {
  return new Set(pairs.map((p) => p.load)).size;
}

describe("complexity.ts property-based tests", () => {
  // -------------------------------------------------------------------------
  // Feature: personal-ai-apm-system, Property 4: Complexity requires five distinct load levels
  //
  // For any set of (load, value) pairs, estimateComplexity returns
  // "insufficient-data" if and only if the pairs contain fewer than 5 distinct
  // load levels. Validates Requirements 6.5, 7.5.
  // -------------------------------------------------------------------------
  it("Property 4: returns insufficient-data iff fewer than 5 distinct load levels", () => {
    fc.assert(
      fc.property(fc.array(pairArb(), { minLength: 0, maxLength: 40 }), (pairs) => {
        const result = estimateComplexity(pairs);
        const distinct = distinctLoadCount(pairs);

        expect(result.distinctLoadLevels).toBe(distinct);

        if (distinct < MIN_DISTINCT_LOAD_LEVELS) {
          // Too few load levels -> insufficient-data.
          expect(result.status).toBe("insufficient-data");
        } else {
          // Enough load levels -> a fit is attempted, so it is never
          // insufficient-data (it is "ok" or "indeterminate").
          expect(result.status).not.toBe("insufficient-data");
          expect(["ok", "indeterminate"]).toContain(result.status);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // Feature: personal-ai-apm-system, Property 5: Best-fit selection with simpler tie-break and fit-quality floor
  //
  // For any set of pairs with at least 5 distinct load levels,
  // estimateComplexity reports the candidate curve with the highest R^2; on
  // ties it selects the simpler curve (constant < logarithmic < linear <
  // linearithmic < quadratic); and it returns "indeterminate" iff the best R^2
  // is below the configured minimum (default 0.7).
  // Validates Requirements 6.2, 6.3, 6.4, 7.2, 7.3, 7.4.
  // -------------------------------------------------------------------------
  it("Property 5: picks highest-R^2 class with simpler tie-break and fit-quality floor", () => {
    fc.assert(
      fc.property(
        // Enough pairs that >=5 distinct load levels is common; we filter to be sure.
        fc
          .array(pairArb(), { minLength: 5, maxLength: 40 })
          .filter((pairs) => distinctLoadCount(pairs) >= MIN_DISTINCT_LOAD_LEVELS),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (pairs, minFitQuality) => {
          const result = estimateComplexity(pairs, minFitQuality);
          const oracle = bestFitOracle(pairs);

          if (oracle === null) {
            // No candidate fittable (flat response) -> indeterminate, no class.
            expect(result.status).toBe("indeterminate");
            expect(result.complexityClass).toBeUndefined();
            return;
          }

          // The reported R^2 must match the best achievable R^2.
          const reportedR2 = result.rSquared;
          expect(reportedR2).toBeDefined();
          expect(reportedR2 as number).toBeCloseTo(oracle.r2, 9);

          if (oracle.r2 < minFitQuality) {
            // Fit-quality floor: below the minimum -> indeterminate.
            expect(result.status).toBe("indeterminate");
            expect(result.complexityClass).toBeUndefined();
          } else {
            // Usable fit -> ok with the simplest class achieving the best R^2.
            expect(result.status).toBe("ok");
            expect(result.complexityClass).toBe(oracle.cls);
            expect(result.plainLanguage).toBeTypeOf("string");

            // Tie-break: no simpler candidate may match the winner's R^2.
            const winnerIdx = CANDIDATE_ORDER.indexOf(oracle.cls);
            const ys = pairs.map((p) => p.value);
            for (let i = 0; i < winnerIdx; i++) {
              const simpler = CANDIDATE_ORDER[i];
              const xs = pairs.map((p) => transform(simpler, p.load));
              const r2 = rSquaredFor(xs, ys, simpler === "constant");
              if (r2 !== null) {
                // A strictly-simpler class must have strictly lower R^2,
                // otherwise it would have been chosen first.
                expect(r2).toBeLessThan(oracle.r2);
              }
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // Feature: personal-ai-apm-system, Property 6: Data generated from a known class is recovered
  //
  // For any load values and a chosen complexity class, values generated
  // exactly from that class (with sufficient distinct points and no noise)
  // yield an "ok" estimate whose reported class equals the generating class.
  // Validates Requirements 6.3, 7.3.
  // -------------------------------------------------------------------------
  it("Property 6: recovers the generating class from clean data", () => {
    // Generate the true value from a class using a positive coefficient so the
    // curve is monotonic and unambiguous. constant is excluded because its
    // regression R^2 is 0 by construction (it cannot "win" on ordering here);
    // it is covered by the unit tests instead.
    const generatableClasses: ComplexityClass[] = [
      "logarithmic",
      "linear",
      "linearithmic",
      "quadratic",
    ];

    fc.assert(
      fc.property(
        fc.constantFrom(...generatableClasses),
        // Distinct, well-spread positive load levels (>=6 for a robust fit).
        fc
          .uniqueArray(
            fc.integer({ min: 2, max: 5000 }),
            { minLength: 6, maxLength: 20 },
          )
          .filter((loads) => loads.length >= 6),
        // Positive slope and non-negative intercept keep the curve monotonic.
        fc.double({ min: 1, max: 1000, noNaN: true }),
        fc.double({ min: 0, max: 1000, noNaN: true }),
        (cls, loads, slope, intercept) => {
          const basis = (load: number): number => {
            switch (cls) {
              case "logarithmic":
                return Math.log(load);
              case "linear":
                return load;
              case "linearithmic":
                return load * Math.log(load);
              case "quadratic":
                return load * load;
              case "constant":
                return 0;
            }
          };

          const pairs: FitInput[] = loads.map((load) => ({
            load,
            value: intercept + slope * basis(load),
          }));

          const result = estimateComplexity(pairs);

          // Clean data from a real curve must produce a usable fit.
          expect(result.status).toBe("ok");
          // The reported class must be the generating class. (No simpler class
          // can achieve an equal-or-better R^2 for strictly-spread clean data
          // from a distinct basis, so the tie-break does not change it.)
          expect(result.complexityClass).toBe(cls);
          expect(result.rSquared as number).toBeGreaterThanOrEqual(
            DEFAULT_MIN_FIT_QUALITY,
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
