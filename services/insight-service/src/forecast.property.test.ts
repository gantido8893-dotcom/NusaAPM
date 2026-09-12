// Feature: personal-ai-apm-system
// Property tests for forecast.ts (estimateRunway) — tasks 5.9 and 5.10.
//
// These two properties are bundled in one file so their fast-check generators
// and helpers do not collide with the example-based unit tests in
// forecast.test.ts.
//
// Property 7 (task 5.9): Runway requires ten data points in the lookback
//   window. Validates Requirement 8.4.
// Property 8 (task 5.10): Runway is reported exactly when the trend crosses
//   the red band within the horizon. Validates Requirements 8.2, 8.3.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { estimateRunway, MIN_DATA_POINTS, MIN_LOOKBACK_MS, MAX_LOOKBACK_MS } from "./forecast.js";
import type { ForecastInput, Sample } from "./types.js";

// A fixed anchor time so the lookback window ("[latest - lookbackMs, latest]")
// is deterministic across runs. All generated samples sit at or before this.
const ANCHOR_MS = 1_700_000_000_000;

describe("forecast.ts property tests", () => {
  // -------------------------------------------------------------------------
  // Feature: personal-ai-apm-system, Property 7: Runway requires ten data
  // points in the lookback window
  // -------------------------------------------------------------------------
  //
  // For any history whose in-window count is < MIN_DATA_POINTS the status is
  // "insufficient-data"; with >= MIN_DATA_POINTS in-window points the status is
  // never "insufficient-data" (it is "ok" or "not-trending"). We build the
  // history directly from the two disjoint groups so we control the in-window
  // count exactly, independent of the fit outcome.
  it("Property 7: fewer than ten in-window points => insufficient-data; ten or more => a decided status", () => {
    fc.assert(
      fc.property(
        // lookback within the valid clamped range so no clamping surprises.
        fc.integer({ min: MIN_LOOKBACK_MS, max: MAX_LOOKBACK_MS }),
        // number of in-window points, straddling the MIN_DATA_POINTS boundary.
        fc.integer({ min: 0, max: 2 * MIN_DATA_POINTS }),
        // number of extra out-of-window (older) points.
        fc.integer({ min: 0, max: 15 }),
        fc.float({ min: Math.fround(-5), max: Math.fround(5), noNaN: true }),
        fc.boolean(),
        (lookbackMs, inCount, outCount, slope, approachFromBelow) => {
          const history: Sample[] = [];

          // In-window points: timestamps within (ANCHOR_MS - lookbackMs, ANCHOR_MS].
          // Spread them out so the fit has time-variance when inCount >= 2.
          for (let i = 0; i < inCount; i++) {
            const frac = inCount === 1 ? 0 : i / (inCount - 1);
            // Keep strictly inside the window: offset in [0, lookbackMs * 0.9].
            const offset = Math.floor(frac * lookbackMs * 0.9);
            const tMs = ANCHOR_MS - offset;
            history.push({ tMs, value: slope * tMs });
          }

          // Out-of-window points: strictly older than the cutoff. The cutoff is
          // ANCHOR_MS - lookbackMs, so place them well before it. These must
          // never be counted. (If inCount === 0 there is no anchor from an
          // in-window sample, but the newest overall sample still anchors the
          // window; we place out points old enough to fall outside regardless.)
          for (let j = 0; j < outCount; j++) {
            const tMs = ANCHOR_MS - lookbackMs - MIN_LOOKBACK_MS - j * 1000;
            history.push({ tMs, value: slope * tMs });
          }

          const input: ForecastInput = {
            history,
            redBandStart: 0,
            lookbackMs,
            horizonMs: MAX_LOOKBACK_MS,
            approachFromBelow,
          };

          // Compute the true in-window count exactly as the module does: the
          // window is [latest - lookbackMs, latest], anchored to the newest
          // sample overall. When inCount === 0 the "out" points self-anchor the
          // window, so some may fall inside; deriving the expectation this way
          // keeps the property faithful to the specified windowing rather than
          // assuming it equals `inCount`.
          const latest = Math.max(...history.map((s) => s.tMs));
          const cutoff = latest - lookbackMs;
          const expectedInWindow = history.filter((s) => s.tMs >= cutoff).length;

          const result = estimateRunway(input);

          expect(result.dataPoints).toBe(expectedInWindow);

          if (expectedInWindow < MIN_DATA_POINTS) {
            expect(result.status).toBe("insufficient-data");
          } else {
            expect(result.status).not.toBe("insufficient-data");
            expect(["ok", "not-trending"]).toContain(result.status);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // -------------------------------------------------------------------------
  // Feature: personal-ai-apm-system, Property 8: Runway is reported exactly
  // when the trend crosses the red band within the horizon
  // -------------------------------------------------------------------------
  //
  // Construct >= 10 in-window points lying exactly on a known linear trend
  // value = slope * t + intercept. Because the points are perfectly linear,
  // the least-squares fit recovers that exact line, so we can compute the
  // ground-truth crossing analytically and assert estimateRunway agrees:
  //   - "ok" with 0 <= timeToCriticalMs <= horizonMs  iff  the line moves in
  //     the correct direction AND its crossing lies within [now, now+horizon];
  //   - "not-trending" otherwise (wrong direction, flat, past, or beyond).
  it("Property 8: ok exactly when the fitted trend crosses redBandStart in-direction within the horizon", () => {
    fc.assert(
      fc.property(
        // n in-window points on the trend line.
        fc.integer({ min: MIN_DATA_POINTS, max: 40 }),
        // spacing between samples (ms), kept small so n points stay in-window.
        fc.integer({ min: 1000, max: 60 * 60 * 1000 }),
        // slope per ms (can be negative, positive, or zero).
        fc.float({ min: Math.fround(-1), max: Math.fround(1), noNaN: true }),
        // intercept (value at t = 0).
        fc.float({ min: Math.fround(-1000), max: Math.fround(1000), noNaN: true }),
        // redBandStart threshold.
        fc.float({ min: Math.fround(-2000), max: Math.fround(2000), noNaN: true }),
        // horizon in ms.
        fc.integer({ min: MIN_LOOKBACK_MS, max: MAX_LOOKBACK_MS }),
        fc.boolean(),
        (n, stepMs, slope, intercept, redBandStart, horizonMs, approachFromBelow) => {
          // Build n points ending at ANCHOR_MS, going backwards by stepMs.
          const history: Sample[] = [];
          for (let i = 0; i < n; i++) {
            const tMs = ANCHOR_MS - (n - 1 - i) * stepMs;
            history.push({ tMs, value: slope * tMs + intercept });
          }
          const nowMs = ANCHOR_MS; // most recent sample

          // Use a lookback large enough that all n points stay in-window.
          const spanMs = (n - 1) * stepMs;
          const lookbackMs = Math.min(
            MAX_LOOKBACK_MS,
            Math.max(MIN_LOOKBACK_MS, spanMs + stepMs),
          );

          const input: ForecastInput = {
            history,
            redBandStart,
            lookbackMs,
            horizonMs,
            approachFromBelow,
          };

          const result = estimateRunway(input);

          // Ground truth. The fit recovers (slope, intercept) exactly for
          // perfectly-linear data, so replicate the module's decision.
          const movingTowardRed = approachFromBelow ? slope > 0 : slope < 0;

          if (!movingTowardRed) {
            // Flat or wrong-direction trend never crosses toward red.
            expect(result.status).toBe("not-trending");
            return;
          }

          const tCross = (redBandStart - intercept) / slope;
          const timeToCriticalMs = tCross - nowMs;

          if (timeToCriticalMs < 0 || timeToCriticalMs > horizonMs) {
            expect(result.status).toBe("not-trending");
          } else {
            expect(result.status).toBe("ok");
            expect(result.timeToCriticalMs).toBeDefined();
            const ttc = result.timeToCriticalMs as number;
            expect(ttc).toBeGreaterThanOrEqual(0);
            expect(ttc).toBeLessThanOrEqual(horizonMs);
            // The reported crossing matches the analytic one (float tolerance).
            const tol = Math.max(1, Math.abs(timeToCriticalMs) * 1e-6);
            expect(Math.abs(ttc - timeToCriticalMs)).toBeLessThanOrEqual(tol);
            expect(result.humanReadable).toBeDefined();
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
