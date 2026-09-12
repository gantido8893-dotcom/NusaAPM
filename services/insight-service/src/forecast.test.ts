// Feature: personal-ai-apm-system
// Example-based unit tests for forecast.ts (estimateRunway) — task 5.11.
//
// Edge cases (Requirements 8.2, 8.3, 8.4):
//   - exactly MIN_DATA_POINTS (10) in-window points — the boundary of the
//     insufficient-data cutoff;
//   - a flat / zero-slope trend — never crosses, so not-trending;
//   - a slope moving away from the red band — wrong direction, so not-trending;
//   - a crossing that lands exactly on the horizon boundary — inclusive, so ok.

import { describe, it, expect } from "vitest";
import { estimateRunway, MIN_DATA_POINTS, humanizeDuration } from "./forecast.js";
import type { ForecastInput, Sample } from "./types.js";

const ANCHOR_MS = 1_700_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Build `n` samples ending at ANCHOR_MS, one per hour going backwards, lying on
 * the line value = slope * (tMs) + intercept computed so that the value at
 * ANCHOR_MS equals `valueAtAnchor` and the per-hour change is `perHour`.
 */
function linearHistory(n: number, valueAtAnchor: number, perHour: number): Sample[] {
  const slopePerMs = perHour / HOUR_MS;
  const history: Sample[] = [];
  for (let i = 0; i < n; i++) {
    const tMs = ANCHOR_MS - (n - 1 - i) * HOUR_MS;
    const value = valueAtAnchor + slopePerMs * (tMs - ANCHOR_MS);
    history.push({ tMs, value });
  }
  return history;
}

// A 30-day lookback comfortably contains a handful of hourly samples.
const LOOKBACK_MS = 30 * DAY_MS;

describe("estimateRunway edge cases (task 5.11)", () => {
  it("exactly 10 in-window points is enough to fit (boundary of insufficient-data)", () => {
    // 10 points rising toward a red band above the current value.
    const history = linearHistory(MIN_DATA_POINTS, 100, 1); // +1 unit/hour
    const input: ForecastInput = {
      history,
      redBandStart: 110,
      lookbackMs: LOOKBACK_MS,
      horizonMs: 30 * DAY_MS,
      approachFromBelow: true,
    };

    const result = estimateRunway(input);

    expect(result.dataPoints).toBe(10);
    expect(result.status).not.toBe("insufficient-data");
    // Rising +1/hr from 100 toward 110 crosses in ~10 hours.
    expect(result.status).toBe("ok");
    expect(result.timeToCriticalMs).toBeCloseTo(10 * HOUR_MS, 0);
  });

  it("nine in-window points is one short => insufficient-data", () => {
    const history = linearHistory(MIN_DATA_POINTS - 1, 100, 1);
    const input: ForecastInput = {
      history,
      redBandStart: 110,
      lookbackMs: LOOKBACK_MS,
      horizonMs: 30 * DAY_MS,
      approachFromBelow: true,
    };

    const result = estimateRunway(input);

    expect(result.status).toBe("insufficient-data");
    expect(result.dataPoints).toBe(9);
  });

  it("flat / zero-slope trend never crosses => not-trending", () => {
    const history = linearHistory(12, 100, 0); // constant 100
    const input: ForecastInput = {
      history,
      redBandStart: 110,
      lookbackMs: LOOKBACK_MS,
      horizonMs: 30 * DAY_MS,
      approachFromBelow: true,
    };

    const result = estimateRunway(input);

    expect(result.status).toBe("not-trending");
    expect(result.slopePerMs).toBe(0);
    expect(result.timeToCriticalMs).toBeUndefined();
  });

  it("slope moving away from the red band => not-trending (approachFromBelow but falling)", () => {
    // Red band is above the value, but the metric is falling — moving away.
    const history = linearHistory(12, 100, -1); // -1 unit/hour
    const input: ForecastInput = {
      history,
      redBandStart: 110,
      lookbackMs: LOOKBACK_MS,
      horizonMs: 30 * DAY_MS,
      approachFromBelow: true,
    };

    const result = estimateRunway(input);

    expect(result.status).toBe("not-trending");
    expect(result.slopePerMs).toBeLessThan(0);
  });

  it("slope moving away from the red band => not-trending (approachFromAbove but rising)", () => {
    // Red band is below the value, but the metric is rising — moving away.
    const history = linearHistory(12, 100, 1); // +1 unit/hour
    const input: ForecastInput = {
      history,
      redBandStart: 90,
      lookbackMs: LOOKBACK_MS,
      horizonMs: 30 * DAY_MS,
      approachFromBelow: false,
    };

    const result = estimateRunway(input);

    expect(result.status).toBe("not-trending");
    expect(result.slopePerMs).toBeGreaterThan(0);
  });

  it("crossing exactly at the horizon boundary is inclusive => ok", () => {
    // Rising +1/hr from 100 toward 110 => crosses in exactly 10 hours.
    const history = linearHistory(12, 100, 1);
    const input: ForecastInput = {
      history,
      redBandStart: 110,
      lookbackMs: LOOKBACK_MS,
      horizonMs: 10 * HOUR_MS, // crossing lands exactly on the horizon
      approachFromBelow: true,
    };

    const result = estimateRunway(input);

    expect(result.status).toBe("ok");
    expect(result.timeToCriticalMs).toBeCloseTo(10 * HOUR_MS, 0);
  });

  it("crossing just beyond the horizon boundary => not-trending", () => {
    // Same trend, but a horizon just under 10 hours excludes the crossing.
    const history = linearHistory(12, 100, 1);
    const input: ForecastInput = {
      history,
      redBandStart: 110,
      lookbackMs: LOOKBACK_MS,
      horizonMs: 10 * HOUR_MS - 60 * 1000, // one minute short
      approachFromBelow: true,
    };

    const result = estimateRunway(input);

    expect(result.status).toBe("not-trending");
  });
});

describe("humanizeDuration (task 5.11 supporting)", () => {
  it("reports whole hours below a day, rounding sub-hour up to 1 hour", () => {
    expect(humanizeDuration(HOUR_MS)).toBe("~1 hour");
    expect(humanizeDuration(3 * HOUR_MS)).toBe("~3 hours");
    expect(humanizeDuration(60 * 1000)).toBe("~1 hour"); // sub-hour rounds up
  });

  it("reports whole days at a day or more", () => {
    expect(humanizeDuration(DAY_MS)).toBe("~1 day");
    expect(humanizeDuration(3 * DAY_MS)).toBe("~3 days");
  });
});
