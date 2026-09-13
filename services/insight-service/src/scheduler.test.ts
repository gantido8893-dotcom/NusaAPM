// Feature: personal-ai-apm-system
// Example-based unit tests for scheduler.ts (startScheduler) — task 7.12.
//
// The scheduler drives the two-tier insight loop (design.md "scheduler.ts —
// two-tier insight cycle"). These tests inject every side-effecting seam
// (collect / analyze / synthesize / now / setTimer / clearTimer) so no real
// timers, Prometheus, or LLM providers are touched — the rules and llm layers
// are fully mocked. They cover:
//
//   - tier-1 runs on EVERY runCycle (analyze stub called each cycle; the latest
//     tier-1 summary is updated) — Requirement 11.1 (tier-1 always-on).
//   - tier-2 fires ONLY on an escalatable finding: a band crossing OR a
//     correlation triggers synthesize; spikes / unmonitored alone do NOT
//     — Requirements 11.1, 11.3.
//   - latest() returns the "ok" explanation carrying its basedOn evidence.
//   - a later skipped-* / no-findings result does NOT clobber a prior good
//     ok latest().
//   - clampInsightCycleMs clamps below 15 min up and above 30 min down.
//   - hasEscalatableFinding truth table.
//   - runTier1 runs tier-1 on demand without escalating to tier-2.
//   - the injected setTimer is used for scheduling and stop() clears it.
//   - a throwing cycle is routed to onError and does not crash the loop.

import { describe, it, expect, vi } from "vitest";
import {
  startScheduler,
  clampInsightCycleMs,
  hasEscalatableFinding,
  MIN_INSIGHT_CYCLE_MS,
  MAX_INSIGHT_CYCLE_MS,
  DEFAULT_INSIGHT_CYCLE_MS,
  type SchedulerConfig,
  type SchedulerDeps,
  type CycleInputs,
  type AnalyzeFn,
  type SynthesizeFn,
} from "./scheduler.js";
import type {
  AiExplanation,
  BandCrossing,
  Correlation,
  SpikeEvent,
  StructuredSummary,
} from "./types.js";

const NOW_MS = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

/** Minimal cycle inputs; the analyze stub ignores them, so shape is enough. */
function makeInputs(): CycleInputs {
  return {
    current: {},
    previousBands: {},
    baselines: {},
    cfg: { metrics: {} },
  };
}

/** Build a StructuredSummary, empty by default; override the finding arrays. */
function makeSummary(overrides: Partial<StructuredSummary> = {}): StructuredSummary {
  const bandCrossings = overrides.bandCrossings ?? [];
  const spikes = overrides.spikes ?? [];
  const correlations = overrides.correlations ?? [];
  const unmonitored = overrides.unmonitored ?? [];
  return {
    cycleTMs: overrides.cycleTMs ?? NOW_MS,
    bandCrossings,
    spikes,
    correlations,
    unmonitored,
    empty:
      overrides.empty ??
      (bandCrossings.length === 0 &&
        spikes.length === 0 &&
        correlations.length === 0),
  };
}

const A_BAND_CROSSING: BandCrossing = {
  metric: "latency_p95",
  from: "yellow",
  to: "red",
  tMs: NOW_MS,
};

const A_CORRELATION: Correlation = {
  metricA: "latency_p95",
  metricB: "cpu",
  withinMs: 30_000,
};

const A_SPIKE: SpikeEvent = {
  metric: "latency_p95",
  value: 500,
  mean: 100,
  stdDev: 20,
  tMs: NOW_MS,
};

/** A usable tier-2 explanation carrying its evidence. */
function okExplanation(basedOn: StructuredSummary): AiExplanation {
  return {
    status: "ok",
    provider: "ollama",
    hypothesis: "Latency rose with CPU saturation.",
    suggestion: "Investigate CPU-bound work on the hot path.",
    basedOn,
    generatedAtMs: NOW_MS,
  };
}

const SKIPPED_EXPLANATION: AiExplanation = {
  status: "skipped-rate-limit",
  generatedAtMs: NOW_MS,
};

/**
 * A manual timer seam: captures the scheduled callback so tests drive cycles
 * deterministically instead of relying on real setInterval. Also records
 * clear() calls so stop() can be asserted.
 */
function makeManualTimer() {
  let captured: (() => void) | undefined;
  let capturedMs: number | undefined;
  const handle = { id: "manual-timer" };
  const cleared: unknown[] = [];
  return {
    setTimer: vi.fn((fn: () => void, ms: number) => {
      captured = fn;
      capturedMs = ms;
      return handle;
    }),
    clearTimer: vi.fn((h: unknown) => {
      cleared.push(h);
    }),
    handle,
    cleared,
    /** Fire the captured periodic callback (as the real timer would). */
    tick: () => {
      if (!captured) throw new Error("setTimer was never called");
      captured();
    },
    get scheduledMs() {
      return capturedMs;
    },
  };
}

const baseCfg: SchedulerConfig = {
  insightCycleMs: MIN_INSIGHT_CYCLE_MS,
  llm: {} as SchedulerConfig["llm"],
};

// ---------------------------------------------------------------------------
// clampInsightCycleMs
// ---------------------------------------------------------------------------

describe("clampInsightCycleMs (15..30 min bounds)", () => {
  it("clamps a value below 15 min up to the minimum", () => {
    expect(clampInsightCycleMs(60_000)).toBe(MIN_INSIGHT_CYCLE_MS);
    expect(clampInsightCycleMs(0)).toBe(MIN_INSIGHT_CYCLE_MS);
    expect(clampInsightCycleMs(-5)).toBe(MIN_INSIGHT_CYCLE_MS);
  });

  it("clamps a value above 30 min down to the maximum", () => {
    expect(clampInsightCycleMs(60 * 60 * 1000)).toBe(MAX_INSIGHT_CYCLE_MS);
    expect(clampInsightCycleMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_INSIGHT_CYCLE_MS);
  });

  it("passes through a value already within range", () => {
    const inRange = 20 * 60 * 1000;
    expect(clampInsightCycleMs(inRange)).toBe(inRange);
    expect(clampInsightCycleMs(MIN_INSIGHT_CYCLE_MS)).toBe(MIN_INSIGHT_CYCLE_MS);
    expect(clampInsightCycleMs(MAX_INSIGHT_CYCLE_MS)).toBe(MAX_INSIGHT_CYCLE_MS);
  });

  it("falls back to the default for a non-finite cadence", () => {
    expect(clampInsightCycleMs(Number.NaN)).toBe(DEFAULT_INSIGHT_CYCLE_MS);
    expect(clampInsightCycleMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_INSIGHT_CYCLE_MS);
  });
});

// ---------------------------------------------------------------------------
// hasEscalatableFinding truth table
// ---------------------------------------------------------------------------

describe("hasEscalatableFinding truth table (Requirement 11.1)", () => {
  it("is false for an empty summary", () => {
    expect(hasEscalatableFinding(makeSummary())).toBe(false);
  });

  it("is false when only spikes are present (spikes alone do not escalate)", () => {
    expect(hasEscalatableFinding(makeSummary({ spikes: [A_SPIKE] }))).toBe(false);
  });

  it("is false when only unmonitored metrics are noted", () => {
    expect(hasEscalatableFinding(makeSummary({ unmonitored: ["disk"] }))).toBe(false);
  });

  it("is true on a band crossing", () => {
    expect(
      hasEscalatableFinding(makeSummary({ bandCrossings: [A_BAND_CROSSING] })),
    ).toBe(true);
  });

  it("is true on a correlation", () => {
    expect(
      hasEscalatableFinding(makeSummary({ correlations: [A_CORRELATION] })),
    ).toBe(true);
  });

  it("is true when both a crossing and a correlation are present", () => {
    expect(
      hasEscalatableFinding(
        makeSummary({ bandCrossings: [A_BAND_CROSSING], correlations: [A_CORRELATION] }),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tier-1 runs every cycle
// ---------------------------------------------------------------------------

describe("tier-1 runs on every cycle (Requirement 11.1)", () => {
  it("calls analyze each runCycle and updates latestSummary", async () => {
    const timer = makeManualTimer();
    const summaries = [makeSummary({ cycleTMs: 1 }), makeSummary({ cycleTMs: 2 })];
    let call = 0;
    const analyze: AnalyzeFn = vi.fn(() => summaries[call++]);
    const synthesize: SynthesizeFn = vi.fn();

    const deps: SchedulerDeps = {
      collect: () => makeInputs(),
      analyze,
      synthesize,
      now: () => NOW_MS,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    };

    const scheduler = startScheduler(deps, baseCfg);

    expect(scheduler.latestSummary()).toBeUndefined();

    await scheduler.runCycle();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(scheduler.latestSummary()?.cycleTMs).toBe(1);

    await scheduler.runCycle();
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(scheduler.latestSummary()?.cycleTMs).toBe(2);

    // Neither cycle had a finding, so tier-2 never ran.
    expect(synthesize).not.toHaveBeenCalled();
    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// tier-2 fires only on a finding
// ---------------------------------------------------------------------------

describe("tier-2 fires only on an escalatable finding (Requirements 11.1, 11.3)", () => {
  it("does NOT synthesize when the summary has only spikes/unmonitored", async () => {
    const timer = makeManualTimer();
    const analyze: AnalyzeFn = vi.fn(() =>
      makeSummary({ spikes: [A_SPIKE], unmonitored: ["disk"] }),
    );
    const synthesize: SynthesizeFn = vi.fn();

    const scheduler = startScheduler(
      {
        collect: () => makeInputs(),
        analyze,
        synthesize,
        now: () => NOW_MS,
        setTimer: timer.setTimer,
        clearTimer: timer.clearTimer,
      },
      baseCfg,
    );

    await scheduler.runCycle();

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(synthesize).not.toHaveBeenCalled();
    expect(scheduler.latest()).toBeUndefined();
    scheduler.stop();
  });

  it("synthesizes on a band crossing and stores latest() with its evidence", async () => {
    const timer = makeManualTimer();
    const summary = makeSummary({ bandCrossings: [A_BAND_CROSSING] });
    const analyze: AnalyzeFn = vi.fn(() => summary);
    const synthesize: SynthesizeFn = vi.fn(async (s) => okExplanation(s));

    const scheduler = startScheduler(
      {
        collect: () => makeInputs(),
        analyze,
        synthesize,
        now: () => NOW_MS,
        setTimer: timer.setTimer,
        clearTimer: timer.clearTimer,
      },
      baseCfg,
    );

    await scheduler.runCycle();

    expect(synthesize).toHaveBeenCalledTimes(1);
    // The exact tier-1 summary is what gets synthesized.
    expect(synthesize).toHaveBeenCalledWith(summary, baseCfg.llm, NOW_MS);

    const latest = scheduler.latest();
    expect(latest?.status).toBe("ok");
    // latest() carries its basedOn evidence for side-by-side display.
    expect(latest?.basedOn).toBe(summary);
    expect(latest?.basedOn?.bandCrossings).toEqual([A_BAND_CROSSING]);
    scheduler.stop();
  });

  it("synthesizes on a correlation alone", async () => {
    const timer = makeManualTimer();
    const summary = makeSummary({ correlations: [A_CORRELATION] });
    const analyze: AnalyzeFn = vi.fn(() => summary);
    const synthesize: SynthesizeFn = vi.fn(async (s) => okExplanation(s));

    const scheduler = startScheduler(
      {
        collect: () => makeInputs(),
        analyze,
        synthesize,
        now: () => NOW_MS,
        setTimer: timer.setTimer,
        clearTimer: timer.clearTimer,
      },
      baseCfg,
    );

    await scheduler.runCycle();

    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(scheduler.latest()?.status).toBe("ok");
    expect(scheduler.latest()?.basedOn?.correlations).toEqual([A_CORRELATION]);
    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// a skipped-* result does not clobber a prior good ok latest()
// ---------------------------------------------------------------------------

describe("latest() preservation across cycles (Requirement 11.3)", () => {
  it("a later skipped-* result does NOT overwrite a prior ok explanation", async () => {
    const timer = makeManualTimer();
    const firstSummary = makeSummary({ bandCrossings: [A_BAND_CROSSING], cycleTMs: 1 });
    const secondSummary = makeSummary({ correlations: [A_CORRELATION], cycleTMs: 2 });
    const summaries = [firstSummary, secondSummary];
    let call = 0;
    const analyze: AnalyzeFn = vi.fn(() => summaries[call++]);

    // First cycle -> ok; second cycle -> skipped (e.g. llm 15-min floor deferred).
    const explanations: AiExplanation[] = [okExplanation(firstSummary), SKIPPED_EXPLANATION];
    let synthCall = 0;
    const synthesize: SynthesizeFn = vi.fn(async () => explanations[synthCall++]);

    const scheduler = startScheduler(
      {
        collect: () => makeInputs(),
        analyze,
        synthesize,
        now: () => NOW_MS,
        setTimer: timer.setTimer,
        clearTimer: timer.clearTimer,
      },
      baseCfg,
    );

    await scheduler.runCycle();
    expect(scheduler.latest()?.status).toBe("ok");
    expect(scheduler.latest()?.basedOn).toBe(firstSummary);

    await scheduler.runCycle();
    // Both cycles escalated (crossing then correlation), so synthesize ran twice,
    // but the skipped-* second result must not clobber the good first insight.
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(scheduler.latest()?.status).toBe("ok");
    expect(scheduler.latest()?.basedOn).toBe(firstSummary);
    scheduler.stop();
  });

  it("a skipped-* result IS surfaced when there is no prior ok explanation", async () => {
    const timer = makeManualTimer();
    const summary = makeSummary({ bandCrossings: [A_BAND_CROSSING] });
    const analyze: AnalyzeFn = vi.fn(() => summary);
    const synthesize: SynthesizeFn = vi.fn(async () => SKIPPED_EXPLANATION);

    const scheduler = startScheduler(
      {
        collect: () => makeInputs(),
        analyze,
        synthesize,
        now: () => NOW_MS,
        setTimer: timer.setTimer,
        clearTimer: timer.clearTimer,
      },
      baseCfg,
    );

    await scheduler.runCycle();

    // No prior insight to preserve: the skip state is surfaced as a well-formed shape.
    expect(scheduler.latest()?.status).toBe("skipped-rate-limit");
    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// runTier1 on demand
// ---------------------------------------------------------------------------

describe("runTier1 runs tier-1 on demand without tier-2 (Requirement 10.1)", () => {
  it("returns the fresh summary and never invokes synthesize", async () => {
    const timer = makeManualTimer();
    const summary = makeSummary({ bandCrossings: [A_BAND_CROSSING] });
    const analyze: AnalyzeFn = vi.fn(() => summary);
    const synthesize: SynthesizeFn = vi.fn();

    const scheduler = startScheduler(
      {
        collect: () => makeInputs(),
        analyze,
        synthesize,
        now: () => NOW_MS,
        setTimer: timer.setTimer,
        clearTimer: timer.clearTimer,
      },
      baseCfg,
    );

    const result = await scheduler.runTier1();

    expect(result).toBe(summary);
    expect(analyze).toHaveBeenCalledTimes(1);
    // Even though this summary has a finding, runTier1 must not escalate.
    expect(synthesize).not.toHaveBeenCalled();
    expect(scheduler.latestSummary()).toBe(summary);
    expect(scheduler.latest()).toBeUndefined();
    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// scheduling seam: setTimer used, stop() clears it
// ---------------------------------------------------------------------------

describe("scheduling seam (design.md Stop)", () => {
  it("schedules via the injected setTimer at the clamped cadence", () => {
    const timer = makeManualTimer();
    const scheduler = startScheduler(
      {
        collect: () => makeInputs(),
        analyze: vi.fn(() => makeSummary()),
        setTimer: timer.setTimer,
        clearTimer: timer.clearTimer,
      },
      // Below the 15-min floor: must be clamped up before scheduling.
      { insightCycleMs: 1000, llm: {} as SchedulerConfig["llm"] },
    );

    expect(timer.setTimer).toHaveBeenCalledTimes(1);
    expect(timer.scheduledMs).toBe(MIN_INSIGHT_CYCLE_MS);
    scheduler.stop();
  });

  it("the scheduled callback drives a full cycle when the timer ticks", async () => {
    const timer = makeManualTimer();
    const summary = makeSummary({ bandCrossings: [A_BAND_CROSSING] });
    const analyze: AnalyzeFn = vi.fn(() => summary);
    const synthesize: SynthesizeFn = vi.fn(async (s) => okExplanation(s));

    const scheduler = startScheduler(
      {
        collect: () => makeInputs(),
        analyze,
        synthesize,
        now: () => NOW_MS,
        setTimer: timer.setTimer,
        clearTimer: timer.clearTimer,
      },
      baseCfg,
    );

    // Simulate the periodic timer firing.
    timer.tick();
    // The cycle runs asynchronously; let microtasks settle.
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(1));
    expect(scheduler.latest()?.status).toBe("ok");
    scheduler.stop();
  });

  it("stop() clears the timer via the injected clearTimer and is idempotent", () => {
    const timer = makeManualTimer();
    const scheduler = startScheduler(
      {
        collect: () => makeInputs(),
        analyze: vi.fn(() => makeSummary()),
        setTimer: timer.setTimer,
        clearTimer: timer.clearTimer,
      },
      baseCfg,
    );

    scheduler.stop();
    scheduler.stop(); // idempotent — must not clear twice

    expect(timer.clearTimer).toHaveBeenCalledTimes(1);
    expect(timer.cleared).toEqual([timer.handle]);
  });
});

// ---------------------------------------------------------------------------
// error handling: a throwing cycle routes to onError, loop survives
// ---------------------------------------------------------------------------

describe("cycle error handling (loop survives a bad cycle)", () => {
  it("routes a collect() rejection to onError instead of crashing", async () => {
    const timer = makeManualTimer();
    const boom = new Error("prometheus unreachable");
    const onError = vi.fn();

    const scheduler = startScheduler(
      {
        collect: () => {
          throw boom;
        },
        analyze: vi.fn(() => makeSummary()),
        now: () => NOW_MS,
        setTimer: timer.setTimer,
        clearTimer: timer.clearTimer,
        onError,
      },
      baseCfg,
    );

    // Fire the periodic callback: its internal cycle throws but is caught.
    timer.tick();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledWith(boom);
    // The scheduler is still usable after a failed cycle.
    expect(scheduler.latest()).toBeUndefined();
    scheduler.stop();
  });

  it("awaiting runCycle directly still rejects so callers can observe failures", async () => {
    const timer = makeManualTimer();
    const boom = new Error("analyze blew up");

    const scheduler = startScheduler(
      {
        collect: () => makeInputs(),
        analyze: vi.fn(() => {
          throw boom;
        }),
        setTimer: timer.setTimer,
        clearTimer: timer.clearTimer,
      },
      baseCfg,
    );

    await expect(scheduler.runCycle()).rejects.toThrow("analyze blew up");
    scheduler.stop();
  });
});
