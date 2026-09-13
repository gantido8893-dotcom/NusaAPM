// Feature: personal-ai-apm-system
// Property test for llm.ts — Property 11 (task 7.8).
//
// This property is kept in its OWN file (separate from Property 10 in
// llm.property.test.ts) so their fast-check generators and mocks do not
// collide.
//
// Property 11 (task 7.8): Only the structured summary reaches the LLM.
//   Validates Requirement 11.2 — ONLY the `StructuredSummary` is ever sent to a
//   provider, never raw time series (no `Sample[]` arrays).
//
// Approach: `buildPrompt` is the single choke point that serializes payload
// data to a provider, and `synthesize` passes that prompt to
// `deps.callProvider`. We generate arbitrary `StructuredSummary` values, run
// `synthesize` with a mock `callProvider` that captures the prompt, and assert:
//   (a) the captured prompt embeds exactly `JSON.stringify(summary)` — i.e. the
//       serialized summary object and nothing more of the payload;
//   (b) the object parsed back out of the prompt has EXACTLY the
//       `StructuredSummary` field set — no extra keys, and in particular no
//       `Sample[]`-shaped raw time series;
//   (c) decoy raw-sample markers that we deliberately keep OUT of the summary
//       never leak into the prompt.
// Provider I/O and the clock are mocked so the test is free and deterministic.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  synthesize,
  buildPrompt,
  defaultLlmConfig,
  type LlmConfig,
  type ProviderResult,
  type LastInvocationStore,
} from "./llm.js";
import { CostGuard } from "./costguard.js";
import type {
  Band,
  BandCrossing,
  Correlation,
  LlmProvider,
  SpikeEvent,
  StructuredSummary,
} from "./types.js";

const NUM_RUNS = 200;

// The exact set of keys on a StructuredSummary. Property 11 asserts the payload
// carries only these — most importantly, no raw `Sample[]` time-series arrays.
const SUMMARY_KEYS = [
  "cycleTMs",
  "bandCrossings",
  "spikes",
  "correlations",
  "unmonitored",
  "empty",
].sort();

const bandArb: fc.Arbitrary<Band> = fc.constantFrom<Band>(
  "green",
  "yellow",
  "red",
  "unknown",
);

const finite = (): fc.Arbitrary<number> =>
  fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true });

const tMsArb = (): fc.Arbitrary<number> =>
  fc.integer({ min: 0, max: 2_000_000_000_000 });

const bandCrossingArb: fc.Arbitrary<BandCrossing> = fc.record({
  metric: fc.string(),
  from: bandArb,
  to: bandArb,
  tMs: tMsArb(),
});

const spikeArb: fc.Arbitrary<SpikeEvent> = fc.record({
  metric: fc.string(),
  value: finite(),
  mean: finite(),
  stdDev: finite(),
  tMs: tMsArb(),
});

const correlationArb: fc.Arbitrary<Correlation> = fc.record({
  metricA: fc.string(),
  metricB: fc.string(),
  withinMs: fc.integer({ min: 0, max: 3_600_000 }),
});

/**
 * A non-empty `StructuredSummary` (empty summaries short-circuit to
 * `no-findings` without contacting a provider, so no prompt would be built).
 * We keep at least one finding so `synthesize` reaches `buildPrompt`.
 */
const nonEmptySummaryArb: fc.Arbitrary<StructuredSummary> = fc
  .record({
    cycleTMs: tMsArb(),
    bandCrossings: fc.array(bandCrossingArb, { maxLength: 5 }),
    spikes: fc.array(spikeArb, { maxLength: 5 }),
    correlations: fc.array(correlationArb, { maxLength: 5 }),
    unmonitored: fc.array(fc.string(), { maxLength: 5 }),
  })
  .map((partial) => {
    // Guarantee at least one finding so the summary is non-empty and a prompt
    // is actually built. If all three finding arrays came out empty, seed one.
    const hasFinding =
      partial.bandCrossings.length > 0 ||
      partial.spikes.length > 0 ||
      partial.correlations.length > 0;
    const bandCrossings = hasFinding
      ? partial.bandCrossings
      : [{ metric: "seed", from: "green" as Band, to: "red" as Band, tMs: 1 }];
    return {
      ...partial,
      bandCrossings,
      empty: false,
    } satisfies StructuredSummary;
  });

/** A config whose 15-min floor never blocks (no previous invocation recorded). */
function freshConfig(): LlmConfig {
  return defaultLlmConfig();
}

/** A last-invocation store that reports "no previous call" so the floor is open. */
function openFloorStore(): LastInvocationStore {
  let tMs: number | undefined;
  return {
    get: () => tMs,
    set: (v: number) => {
      tMs = v;
    },
  };
}

describe("llm.ts property test — Property 11", () => {
  // -------------------------------------------------------------------------
  // Feature: personal-ai-apm-system, Property 11: Only the structured summary
  // reaches the LLM
  // -------------------------------------------------------------------------
  it("Property 11: the prompt passed to the provider contains exactly the StructuredSummary and no raw samples", async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmptySummaryArb,
        // Decoy raw `Sample[]`-style time series. These represent the raw data
        // that MUST NOT reach the LLM. Each carries a unique marker string that
        // does not appear anywhere in the summary, so if any leaked into the
        // prompt we would detect it.
        fc.array(
          fc.record({ tMs: tMsArb(), value: finite() }),
          { minLength: 1, maxLength: 10 },
        ),
        fc.uuid(),
        async (summary, rawSamples, marker) => {
          // Embed the unique marker into the raw samples we hold back. It must
          // never surface in the prompt.
          const rawMarker = `RAW_SAMPLE_MARKER_${marker}`;
          const decoyRaw = { marker: rawMarker, samples: rawSamples };

          let captured: string | undefined;
          const callProvider = async (
            _provider: LlmProvider,
            prompt: string,
            _cfg: LlmConfig,
          ): Promise<ProviderResult> => {
            captured = prompt;
            return { hypothesis: "h", suggestion: "s" };
          };

          const result = await synthesize(summary, freshConfig(), Date.now(), {
            callProvider,
            lastInvocation: openFloorStore(),
            // Isolated cost guard so property runs don't share state.
            costGuard: new CostGuard(() => 0),
          });

          // A provider was contacted and returned a result.
          expect(result.status).toBe("ok");
          expect(captured).toBeDefined();
          const prompt = captured as string;

          // (a) The prompt embeds exactly the serialized summary. buildPrompt is
          // the single choke point, so its output is the ground truth for what
          // is sent, and it must equal what synthesize forwarded.
          expect(prompt).toBe(buildPrompt(summary));
          expect(prompt).toContain(JSON.stringify(summary));

          // (b) The JSON object embedded in the prompt has EXACTLY the
          // StructuredSummary keys — no extra fields, and no raw `Sample[]`
          // array leaked in. The builder emits the payload after a "SUMMARY:\n"
          // marker; everything before it is fixed instruction text (which may
          // itself mention JSON shapes), so we parse only the trailing payload.
          const marker11 = "SUMMARY:\n";
          const markerIdx = prompt.indexOf(marker11);
          expect(markerIdx).toBeGreaterThanOrEqual(0);
          const payloadJson = prompt.slice(markerIdx + marker11.length);
          const embedded = JSON.parse(payloadJson) as Record<string, unknown>;
          expect(Object.keys(embedded).sort()).toEqual(SUMMARY_KEYS);

          // The embedded payload round-trips to the original summary exactly.
          // We compare against the JSON-normalized summary rather than the raw
          // object: JSON has no signed zero, so a `-0` in the summary (e.g. a
          // spike's stdDev) serializes to "0" and parses back as `0`. vitest's
          // toEqual distinguishes `-0` from `0`, so comparing to the un-normalized
          // summary would spuriously fail on that round-trip artifact. Normalizing
          // both sides through JSON still proves the payload round-trips to exactly
          // the summary (the whole point of the property) without weakening it.
          expect(embedded).toEqual(JSON.parse(JSON.stringify(summary)));

          // (c) None of the deliberately-withheld raw-sample data leaks. Neither
          // the unique marker nor the serialized raw samples appear anywhere in
          // the prompt. (decoyRaw was never passed to synthesize; this guards
          // against buildPrompt ever being widened to include raw series.)
          expect(prompt).not.toContain(rawMarker);
          expect(prompt).not.toContain(JSON.stringify(decoyRaw.samples));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
