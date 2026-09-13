// Feature: personal-ai-apm-system
// Property-based tests for llm.ts (design.md "Correctness Properties").
//
// Covers:
//   Property 10: LLM invocation respects the 15-minute minimum   (task 7.7)
//   Validates: Requirement 11.3
//
// The property runs with fast-check at >= 100 iterations. All provider I/O is
// mocked (an injected `callProvider` counter) and the clock is passed in as
// `now`, so the test is deterministic and free (Requirement 13). No real
// Ollama/Gemini/Groq endpoint is ever contacted.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  synthesize,
  defaultLlmConfig,
  MIN_INTERVAL_MS,
  type LastInvocationStore,
  type ProviderResult,
} from "./llm.js";
import type { LlmProvider, StructuredSummary } from "./types.js";

const RUNS = 300; // >= 100 iterations per task requirement

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

/**
 * A NON-EMPTY structured summary so `synthesize` does not short-circuit to
 * `no-findings`. It carries a single band crossing — enough to make the cycle a
 * candidate for a provider call, gated only by the 15-minute floor.
 */
function nonEmptySummary(cycleTMs: number): StructuredSummary {
  return {
    cycleTMs,
    bandCrossings: [{ metric: "latency_p95", from: "yellow", to: "red", tMs: cycleTMs }],
    spikes: [],
    correlations: [],
    unmonitored: [],
    empty: false,
  };
}

/** A mutable in-memory last-invocation store (mirrors the module default). */
function makeStore(initial?: number): LastInvocationStore {
  let tMs = initial;
  return {
    get: () => tMs,
    set: (v: number) => {
      tMs = v;
    },
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * A strictly-increasing sequence of scheduled cycle times (epoch-ms). Real
 * scheduler cycles are monotonic; we build one from a start time plus positive
 * gaps. Gaps deliberately straddle the 15-minute floor (some well below, some
 * well above) so both the "deferred" and "allowed" branches are exercised.
 */
const cycleTimesArb: fc.Arbitrary<number[]> = fc
  .record({
    start: fc.integer({ min: 0, max: 1_000_000 }),
    gaps: fc.array(
      // 1ms .. 30min gaps: a spread that crosses the 15-min floor in both
      // directions many times over a run.
      fc.integer({ min: 1, max: 30 * 60 * 1000 }),
      { minLength: 1, maxLength: 40 },
    ),
  })
  .map(({ start, gaps }) => {
    const times: number[] = [start];
    let t = start;
    for (const g of gaps) {
      t += g;
      times.push(t);
    }
    return times;
  });

/** Configurable floor >= the 15-minute hard minimum. */
const minIntervalArb: fc.Arbitrary<number> = fc.oneof(
  fc.constant(MIN_INTERVAL_MS), // exactly the 15-min floor
  fc.integer({ min: MIN_INTERVAL_MS, max: 60 * 60 * 1000 }), // >= floor, up to 1h
);

// ---------------------------------------------------------------------------
// Property 10: LLM invocation respects the 15-minute minimum
// ---------------------------------------------------------------------------

describe("Property 10: LLM invocation respects the 15-minute minimum", () => {
  // Feature: personal-ai-apm-system, Property 10: LLM invocation respects the 15-minute minimum
  it("never issues an actual provider call < 15 min after the previous actual call; violating cycles are skipped without calling the provider", async () => {
    await fc.assert(
      fc.asyncProperty(cycleTimesArb, minIntervalArb, async (times, minIntervalMs) => {
        const effectiveFloor = Math.max(minIntervalMs, MIN_INTERVAL_MS);
        const cfg = defaultLlmConfig({ minIntervalMs });

        // Shared floor store persists across the whole cycle sequence.
        const store = makeStore();

        // The synthesize signature passes `now`; we stash it so the mock can
        // stamp the correct call time without re-plumbing the signature.
        let currentNow = 0;

        // Record the timestamp of every ACTUAL provider call. `now` is the
        // cycle time, so it doubles as the call timestamp.
        const actualCallTimes: number[] = [];
        const callProvider = async (
          _provider: LlmProvider,
          _prompt: string,
        ): Promise<ProviderResult> => {
          actualCallTimes.push(currentNow);
          return { hypothesis: "h", suggestion: "s" };
        };

        // Local mirror of the last ACTUAL provider-call time, advanced only
        // when the mocked provider is actually invoked — exactly the state the
        // module gates on.
        let lastActual: number | undefined;

        for (const now of times) {
          currentNow = now;

          const callsBefore = actualCallTimes.length;
          const result = await synthesize(nonEmptySummary(now), cfg, now, {
            callProvider,
            lastInvocation: store,
          });
          const didCall = actualCallTimes.length > callsBefore;

          // A cycle within the floor of the previous ACTUAL call must be
          // deferred: skipped-rate-limit AND no provider call issued.
          if (lastActual !== undefined && now - lastActual < effectiveFloor) {
            expect(didCall).toBe(false);
            expect(result.status).toBe("skipped-rate-limit");
          } else {
            // Otherwise the (non-empty) summary is allowed through and the
            // mocked provider returns ok, stamping the floor.
            expect(didCall).toBe(true);
            expect(result.status).toBe("ok");
            expect(store.get()).toBe(now);
            lastActual = now;
          }
        }

        // Global invariant: consecutive ACTUAL provider calls are always >=
        // the effective floor (>= 15 min) apart — the heart of Requirement 11.3.
        for (let i = 1; i < actualCallTimes.length; i++) {
          expect(actualCallTimes[i] - actualCallTimes[i - 1]).toBeGreaterThanOrEqual(
            effectiveFloor,
          );
          // And therefore always >= the 15-minute hard minimum.
          expect(actualCallTimes[i] - actualCallTimes[i - 1]).toBeGreaterThanOrEqual(
            MIN_INTERVAL_MS,
          );
        }
      }),
      { numRuns: RUNS },
    );
  });

  // Feature: personal-ai-apm-system, Property 10: LLM invocation respects the 15-minute minimum
  it("a cycle exactly at the floor boundary is allowed; one millisecond earlier is deferred", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1_000_000 }),
        minIntervalArb,
        async (last, minIntervalMs) => {
          const effectiveFloor = Math.max(minIntervalMs, MIN_INTERVAL_MS);
          const cfg = defaultLlmConfig({ minIntervalMs });

          let calls = 0;
          const callProvider = async (): Promise<ProviderResult> => {
            calls += 1;
            return { hypothesis: "h", suggestion: "s" };
          };

          // Exactly at the floor: allowed (now - last === floor, not < floor).
          {
            const store = makeStore(last);
            const now = last + effectiveFloor;
            const res = await synthesize(nonEmptySummary(now), cfg, now, {
              callProvider,
              lastInvocation: store,
            });
            expect(res.status).toBe("ok");
          }

          // One millisecond before the floor: deferred, no provider call.
          {
            const store = makeStore(last);
            const now = last + effectiveFloor - 1;
            const callsBefore = calls;
            const res = await synthesize(nonEmptySummary(now), cfg, now, {
              callProvider,
              lastInvocation: store,
            });
            expect(res.status).toBe("skipped-rate-limit");
            expect(calls).toBe(callsBefore); // provider NOT invoked
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});
