// Feature: personal-ai-apm-system
// Example-based unit tests for llm.ts fallback and skip statuses (task 7.9).
//
// Verifies the tier-2 synthesis contract's discrete outcomes with ALL provider
// I/O mocked via an injected `callProvider` (a vi.fn), so no real Ollama /
// Gemini / Groq call is ever made and the suite stays $0 (Requirement 13):
//
//   1. Ollama returns a result -> `ok` with provider "ollama".
//   2. Ollama throws (timeout)  -> Gemini called -> `ok` with provider "gemini".
//   3. Ollama + Gemini throw    -> Groq called   -> `ok` with provider "groq".
//   4. Empty summary            -> `no-findings`; callProvider never called.
//   5. Within the 15-min floor  -> `skipped-rate-limit`; callProvider never called.
//   6. Gemini + Groq both over their documented free-tier limit -> the providers
//      are skipped, `costGuard.raise` is invoked with a
//      `free-tier-limit-exceeded` flag, and `skipped-free-tier-limit` is returned.
//
// Requirements: 11.4 (Ollama default), 11.5 (Gemini -> Groq fallback),
// 11.6 (free-tier limit skip + costguard flag).

import { describe, it, expect, vi } from "vitest";
import {
  synthesize,
  defaultLlmConfig,
  type LastInvocationStore,
  type FreeTierUsage,
  type ProviderResult,
} from "./llm.js";
import type {
  LlmProvider,
  StructuredSummary,
} from "./types.js";
import type { CostGuard } from "./costguard.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A non-empty summary with a single band crossing so synthesis proceeds. */
function findingSummary(cycleTMs = 0): StructuredSummary {
  return {
    cycleTMs,
    bandCrossings: [{ metric: "latency_p95", from: "yellow", to: "red", tMs: cycleTMs }],
    spikes: [],
    correlations: [],
    unmonitored: [],
    empty: false,
  };
}

/** An empty summary (nothing detected this cycle). */
function emptySummary(cycleTMs = 0): StructuredSummary {
  return {
    cycleTMs,
    bandCrossings: [],
    spikes: [],
    correlations: [],
    unmonitored: [],
    empty: true,
  };
}

/** A fixed last-invocation store seeded with an optional timestamp. */
function fixedLastInvocation(tMs?: number): LastInvocationStore {
  let value = tMs;
  return {
    get: () => value,
    set: (v: number) => {
      value = v;
    },
  };
}

/** Free-tier usage with per-provider per-minute / per-day counts. */
function usageWith(
  counts: Partial<Record<LlmProvider, { perMinute?: number; perDay?: number }>>,
): FreeTierUsage {
  return {
    perMinute: (provider) => counts[provider]?.perMinute ?? 0,
    perDay: (provider) => counts[provider]?.perDay ?? 0,
  };
}

/** A fake CostGuard whose `raise` is a spy; other methods are no-ops. */
function fakeCostGuard(): CostGuard {
  return {
    raise: vi.fn(),
    active: vi.fn(() => []),
    acknowledge: vi.fn(() => false),
    all: vi.fn(() => []),
  } as unknown as CostGuard;
}

/** A ProviderResult marker for a given provider. */
function okResult(provider: LlmProvider): ProviderResult {
  return {
    hypothesis: `hypothesis from ${provider}`,
    suggestion: `suggestion from ${provider}`,
  };
}

// ---------------------------------------------------------------------------
// 1. Ollama (default) returns a result
// ---------------------------------------------------------------------------

describe("synthesize — Ollama default success (Requirement 11.4)", () => {
  it("returns ok with provider 'ollama' when the default provider succeeds", async () => {
    const callProvider = vi.fn(async (provider: LlmProvider) => okResult(provider));
    const cfg = defaultLlmConfig();

    const result = await synthesize(findingSummary(), cfg, 1_000_000, {
      callProvider,
      lastInvocation: fixedLastInvocation(),
    });

    expect(result.status).toBe("ok");
    expect(result.provider).toBe("ollama");
    expect(result.hypothesis).toBe("hypothesis from ollama");
    expect(result.suggestion).toBe("suggestion from ollama");
    expect(result.basedOn).toEqual(findingSummary());
    // Only the default provider was contacted; no fallback.
    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(callProvider.mock.calls[0][0]).toBe("ollama");
  });
});

// ---------------------------------------------------------------------------
// 2. Ollama timeout -> Gemini
// ---------------------------------------------------------------------------

describe("synthesize — Ollama timeout falls back to Gemini (Requirement 11.5)", () => {
  it("returns ok with provider 'gemini' when Ollama throws and Gemini succeeds", async () => {
    const callProvider = vi.fn(async (provider: LlmProvider) => {
      if (provider === "ollama") throw new Error("ollama timeout (aborted)");
      return okResult(provider);
    });
    const cfg = defaultLlmConfig();

    const result = await synthesize(findingSummary(), cfg, 2_000_000, {
      callProvider,
      lastInvocation: fixedLastInvocation(),
    });

    expect(result.status).toBe("ok");
    expect(result.provider).toBe("gemini");
    expect(result.hypothesis).toBe("hypothesis from gemini");
    // Ollama tried first, then Gemini.
    expect(callProvider).toHaveBeenCalledTimes(2);
    expect(callProvider.mock.calls[0][0]).toBe("ollama");
    expect(callProvider.mock.calls[1][0]).toBe("gemini");
  });
});

// ---------------------------------------------------------------------------
// 3. Ollama + Gemini throw -> Groq
// ---------------------------------------------------------------------------

describe("synthesize — Ollama + Gemini fail, falls back to Groq (Requirement 11.5)", () => {
  it("returns ok with provider 'groq' when only Groq succeeds", async () => {
    const callProvider = vi.fn(async (provider: LlmProvider) => {
      if (provider === "ollama" || provider === "gemini") {
        throw new Error(`${provider} unavailable`);
      }
      return okResult(provider);
    });
    const cfg = defaultLlmConfig();

    const result = await synthesize(findingSummary(), cfg, 3_000_000, {
      callProvider,
      lastInvocation: fixedLastInvocation(),
    });

    expect(result.status).toBe("ok");
    expect(result.provider).toBe("groq");
    expect(result.suggestion).toBe("suggestion from groq");
    // Full chain: ollama -> gemini -> groq.
    expect(callProvider).toHaveBeenCalledTimes(3);
    expect(callProvider.mock.calls.map((c) => c[0])).toEqual([
      "ollama",
      "gemini",
      "groq",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Empty summary -> no-findings; provider never contacted
// ---------------------------------------------------------------------------

describe("synthesize — empty summary short-circuits (Requirement 11.4/11.5)", () => {
  it("returns no-findings and never contacts a provider for an empty summary", async () => {
    const callProvider = vi.fn(async (provider: LlmProvider) => okResult(provider));

    const result = await synthesize(emptySummary(), defaultLlmConfig(), 5_000_000, {
      callProvider,
      lastInvocation: fixedLastInvocation(),
    });

    expect(result.status).toBe("no-findings");
    expect(result.provider).toBeUndefined();
    expect(callProvider).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. Within the 15-minute floor -> skipped-rate-limit; provider never contacted
// ---------------------------------------------------------------------------

describe("synthesize — 15-minute floor defers the cycle (Requirement 11.3/11.5)", () => {
  it("returns skipped-rate-limit and never contacts a provider inside the floor", async () => {
    const callProvider = vi.fn(async (provider: LlmProvider) => okResult(provider));
    const lastCallMs = 10_000_000;
    // 5 minutes after the last call — well inside the 15-minute floor.
    const now = lastCallMs + 5 * 60 * 1000;

    const result = await synthesize(findingSummary(), defaultLlmConfig(), now, {
      callProvider,
      lastInvocation: fixedLastInvocation(lastCallMs),
    });

    expect(result.status).toBe("skipped-rate-limit");
    expect(result.basedOn).toBeDefined();
    expect(callProvider).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Gemini + Groq both over free-tier limit -> skipped-free-tier-limit
// ---------------------------------------------------------------------------

describe("synthesize — all fallbacks over free-tier limit (Requirement 11.6)", () => {
  it("skips Gemini and Groq, raises a free-tier flag, returns skipped-free-tier-limit", async () => {
    // Ollama fails, so we fall to the keyed providers — both of which are at
    // their documented free-tier limit and must be skipped, not called.
    const callProvider = vi.fn(async (provider: LlmProvider) => {
      if (provider === "ollama") throw new Error("ollama unavailable");
      // Should never be reached for gemini/groq — they are skipped.
      return okResult(provider);
    });
    const costGuard = fakeCostGuard();

    const cfg = defaultLlmConfig({
      geminiFreeTierLimit: { perMinute: 15, perDay: 1500 },
      groqFreeTierLimit: { perMinute: 30, perDay: 1000 },
    });
    // Usage already at each provider's per-minute limit.
    const usage = usageWith({
      gemini: { perMinute: 15 },
      groq: { perMinute: 30 },
    });

    const result = await synthesize(findingSummary(), cfg, 20_000_000, {
      callProvider,
      lastInvocation: fixedLastInvocation(),
      usage,
      costGuard,
    });

    expect(result.status).toBe("skipped-free-tier-limit");
    expect(result.basedOn).toBeDefined();

    // Ollama was attempted (and failed); the keyed providers were skipped, not called.
    expect(callProvider.mock.calls.map((c) => c[0])).toEqual(["ollama"]);

    // A free-tier-limit flag was raised for each skipped provider.
    expect(costGuard.raise).toHaveBeenCalledTimes(2);
    const kinds = (costGuard.raise as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0].kind,
    );
    expect(kinds).toEqual([
      "free-tier-limit-exceeded",
      "free-tier-limit-exceeded",
    ]);
    const components = (costGuard.raise as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0].component,
    );
    expect(components).toEqual(["llm", "llm"]);
  });

  it("skips Gemini on a per-day limit while Groq still succeeds", async () => {
    // Only Gemini is over its documented daily limit; Groq is under and should
    // be called and succeed (partial free-tier skip, not a full skip).
    const callProvider = vi.fn(async (provider: LlmProvider) => {
      if (provider === "ollama") throw new Error("ollama unavailable");
      return okResult(provider);
    });
    const costGuard = fakeCostGuard();

    const cfg = defaultLlmConfig({
      geminiFreeTierLimit: { perDay: 1500 },
      groqFreeTierLimit: { perDay: 1000 },
    });
    const usage = usageWith({
      gemini: { perDay: 1500 }, // at the daily limit -> skip
      groq: { perDay: 10 }, // well under -> call
    });

    const result = await synthesize(findingSummary(), cfg, 30_000_000, {
      callProvider,
      lastInvocation: fixedLastInvocation(),
      usage,
      costGuard,
    });

    expect(result.status).toBe("ok");
    expect(result.provider).toBe("groq");
    // Ollama attempted, Gemini skipped, Groq called.
    expect(callProvider.mock.calls.map((c) => c[0])).toEqual(["ollama", "groq"]);
    // Exactly one free-tier flag (for Gemini).
    expect(costGuard.raise).toHaveBeenCalledTimes(1);
  });
});
