// Feature: personal-ai-apm-system
// Property-based tests for thresholds.ts (design.md "Correctness Properties").
//
// Covers:
//   Property 1: Classification is total and single-band            (tasks 3.2)
//   Property 2: Only valid band configs are accepted               (tasks 3.3)
//   Property 3: Percentage-of-critical is defined exactly when a
//               critical band exists                               (tasks 3.4)
//
// All properties run with fast-check at >= 100 iterations. The module under
// test is pure/deterministic, so no mocking is needed and the tests stay free
// (Requirement 13).

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  validateThreshold,
  classify,
  percentOfCritical,
  ThresholdStore,
} from "./thresholds.js";
import type {
  Band,
  BandRange,
  MetricThreshold,
  ThresholdConfig,
} from "./types.js";

const RUNS = 200; // >= 100 iterations per task requirement

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * A well-formed, contiguous, non-overlapping, gap-free MetricThreshold.
 *
 * We pick three ascending, strictly-increasing boundaries starting from a base
 * value and lay green/yellow/red end-to-end so that once sorted they abut
 * exactly: green=[b0,b1), yellow=[b1,b2), red=[b2,b3). validateThreshold sorts
 * by lower bound, so the *labels* can be assigned in any numeric order; here we
 * keep them ascending which is the common (and simplest) valid arrangement.
 */
const validThresholdArb: fc.Arbitrary<MetricThreshold> = fc
  .record({
    base: fc.integer({ min: -1000, max: 1000 }),
    // Three strictly positive widths so all three bands are non-empty.
    w1: fc.integer({ min: 1, max: 500 }),
    w2: fc.integer({ min: 1, max: 500 }),
    w3: fc.integer({ min: 1, max: 500 }),
    metric: fc.string({ minLength: 1, maxLength: 12 }),
  })
  .map(({ base, w1, w2, w3, metric }) => {
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

/** A finite BandRange whose min/max are arbitrary (may be malformed). */
const anyRangeArb: fc.Arbitrary<BandRange> = fc.record({
  min: fc.integer({ min: -1000, max: 1000 }),
  max: fc.integer({ min: -1000, max: 1000 }),
});

/**
 * An arbitrary MetricThreshold that may be valid or invalid: bands may overlap,
 * leave gaps, or (via the mutation below) be dropped entirely. This exercises
 * both branches of validateThreshold for Property 2.
 */
const arbitraryThresholdArb: fc.Arbitrary<MetricThreshold> = fc.record({
  metric: fc.string({ minLength: 1, maxLength: 12 }),
  green: anyRangeArb,
  yellow: anyRangeArb,
  red: anyRangeArb,
});

// ---------------------------------------------------------------------------
// Independent reference oracle for validity (mirrors the spec, not the impl).
// A config is valid iff all three bands are well-formed half-open ranges and,
// once sorted by lower bound, they abut exactly with no gap or overlap.
// ---------------------------------------------------------------------------

function isWellFormed(r: BandRange | undefined): r is BandRange {
  return (
    !!r &&
    Number.isFinite(r.min) &&
    Number.isFinite(r.max) &&
    r.min < r.max
  );
}

function referenceValid(t: MetricThreshold): boolean {
  const ranges = [t.green, t.yellow, t.red];
  if (!ranges.every(isWellFormed)) return false;
  const sorted = [...(ranges as BandRange[])].sort((a, b) => a.min - b.min);
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].max !== sorted[i + 1].min) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Property 1: Classification is total and single-band
// ---------------------------------------------------------------------------

describe("Property 1: Classification is total and single-band", () => {
  // Feature: personal-ai-apm-system, Property 1: Classification is total and single-band
  it("returns exactly one definite band inside the covered range, unknown only outside", () => {
    fc.assert(
      fc.property(
        validThresholdArb,
        fc.double({ min: -5000, max: 5000, noNaN: true }),
        (t, value) => {
          const cfg: ThresholdConfig = { metrics: { [t.metric]: t } };
          const band: Band = classify(cfg, t.metric, value);

          // Result is always one of the four allowed labels (totality).
          expect(["green", "yellow", "red", "unknown"]).toContain(band);

          // Determine set-theoretically which bands contain the value.
          const containing: Band[] = [];
          if (value >= t.green.min && value < t.green.max) containing.push("green");
          if (value >= t.yellow.min && value < t.yellow.max) containing.push("yellow");
          if (value >= t.red.min && value < t.red.max) containing.push("red");

          // Because the config is valid (contiguous, non-overlapping), a value
          // can be inside AT MOST one band — never two (single-band).
          expect(containing.length).toBeLessThanOrEqual(1);

          if (containing.length === 1) {
            // Inside the covered range -> exactly that definite band.
            expect(band).toBe(containing[0]);
            expect(band).not.toBe("unknown");
          } else {
            // Outside every band -> unknown.
            expect(band).toBe("unknown");
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  // Feature: personal-ai-apm-system, Property 1: Classification is total and single-band
  it("a value strictly inside the overall covered range always yields a definite band", () => {
    fc.assert(
      fc.property(
        validThresholdArb,
        fc.double({ min: 0, max: 1, noNaN: true }),
        (t, frac) => {
          const cfg: ThresholdConfig = { metrics: { [t.metric]: t } };
          const lo = t.green.min; // sorted ascending in the generator
          const hi = t.red.max;
          // A point strictly within [lo, hi) is guaranteed covered.
          const value = lo + frac * (hi - lo) * 0.999999;
          const band = classify(cfg, t.metric, value);
          expect(band).not.toBe("unknown");
          expect(["green", "yellow", "red"]).toContain(band);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Only valid band configs are accepted
// ---------------------------------------------------------------------------

describe("Property 2: Only valid band configs are accepted", () => {
  // Feature: personal-ai-apm-system, Property 2: Only valid band configs are accepted
  it("validateThreshold accepts iff bands are contiguous, non-overlapping, gap-free, and all present", () => {
    // A generator that may drop a band entirely (missing-band case) in addition
    // to overlaps/gaps from arbitraryThresholdArb.
    const maybeMissingArb = arbitraryThresholdArb.chain((t) =>
      fc
        .constantFrom<"none" | "green" | "yellow" | "red">("none", "green", "yellow", "red")
        .map((drop) => {
          if (drop === "none") return t;
          const copy: MetricThreshold = { ...t };
          // Simulate a missing band as the spec/impl treats it.
          (copy as unknown as Record<string, unknown>)[drop] = undefined;
          return copy;
        }),
    );

    fc.assert(
      fc.property(maybeMissingArb, (t) => {
        const result = validateThreshold(t);
        expect(result.valid).toBe(referenceValid(t));
        // Rejected configs must explain why.
        if (!result.valid) {
          expect(result.errors.length).toBeGreaterThan(0);
        } else {
          expect(result.errors).toEqual([]);
        }
      }),
      { numRuns: RUNS },
    );
  });

  // Feature: personal-ai-apm-system, Property 2: Only valid band configs are accepted
  it("every generated valid config is accepted", () => {
    fc.assert(
      fc.property(validThresholdArb, (t) => {
        expect(validateThreshold(t).valid).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  // Feature: personal-ai-apm-system, Property 2: Only valid band configs are accepted
  it("ThresholdStore retains the prior config when a rejected config is submitted", () => {
    fc.assert(
      fc.property(validThresholdArb, arbitraryThresholdArb, (goodT, maybeBadT) => {
        const store = new ThresholdStore({ metrics: { [goodT.metric]: goodT } });
        const before = store.getConfig();

        // Submit a whole-config replacement that includes a possibly-invalid entry.
        const proposed: ThresholdConfig = { metrics: { m: maybeBadT } };
        const res = store.setConfig(proposed);

        if (referenceValid(maybeBadT)) {
          // Accepted -> config changed to the proposed one.
          expect(res.valid).toBe(true);
          expect(store.getConfig()).toBe(proposed);
        } else {
          // Rejected -> prior config retained unchanged.
          expect(res.valid).toBe(false);
          expect(store.getConfig()).toBe(before);
        }
      }),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Percentage-of-critical is defined exactly when a critical band exists
// ---------------------------------------------------------------------------

describe("Property 3: Percentage-of-critical is defined exactly when a critical band exists", () => {
  // Feature: personal-ai-apm-system, Property 3: Percentage-of-critical is defined exactly when a critical band exists
  it("returns a number iff a well-formed red (critical) band exists, undefined otherwise", () => {
    // Build thresholds where the red band is sometimes present/well-formed and
    // sometimes malformed/absent, independent of green/yellow.
    const redVariantArb = fc.oneof(
      // Well-formed red band.
      fc.record({ min: fc.integer({ min: 1, max: 900 }), max: fc.integer({ min: 901, max: 2000 }) }),
      // Malformed red band: min >= max.
      fc.record({ min: fc.integer({ min: 500, max: 1000 }), max: fc.integer({ min: -1000, max: 500 }) }),
      // Absent red band.
      fc.constant(undefined),
    );

    fc.assert(
      fc.property(
        redVariantArb,
        fc.double({ min: -5000, max: 5000, noNaN: true }),
        (red, value) => {
          const t = {
            metric: "m",
            green: { min: 0, max: 10 },
            yellow: { min: 10, max: 20 },
            red: red as BandRange,
          } as MetricThreshold;

          const pct = percentOfCritical(t, value);
          const wellFormedRed = isWellFormed(red);

          if (wellFormedRed) {
            expect(typeof pct).toBe("number");
            expect(Number.isFinite(pct as number)).toBe(true);
          } else {
            expect(pct).toBeUndefined();
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  // Feature: personal-ai-apm-system, Property 3: Percentage-of-critical is defined exactly when a critical band exists
  it("for any valid threshold (which always has a red band) the percentage is a finite number", () => {
    fc.assert(
      fc.property(
        validThresholdArb,
        fc.double({ min: -5000, max: 5000, noNaN: true }),
        (t, value) => {
          const pct = percentOfCritical(t, value);
          expect(typeof pct).toBe("number");
          expect(Number.isFinite(pct as number)).toBe(true);
        },
      ),
      { numRuns: RUNS },
    );
  });
});
