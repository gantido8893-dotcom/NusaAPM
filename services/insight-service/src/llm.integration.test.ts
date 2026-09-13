// Feature: personal-ai-apm-system
// OPTIONAL live-connectivity integration check for llm.ts (task 7.10).
//
// This suite verifies that the tier-2 synthesis path can talk to a REAL LLM
// provider end to end — by default a locally running Ollama server. Unlike the
// unit/property tests (llm.test.ts, llm.property.test.ts,
// llm.payload.property.test.ts), which mock all provider I/O so they stay $0
// and deterministic (Requirement 13), this test makes an actual network call.
//
// Because it needs an external dependency — a running local model (Ollama) or a
// keyed fallback account — it is OPTIONAL and MUST NEVER block the build or the
// test suite (tasks.md task 7.10 + the "Notes" section). It is therefore
// SKIPPED BY DEFAULT and only runs when the caller explicitly opts in with:
//
//     LLM_INTEGRATION=1  OLLAMA_URL=http://localhost:11434  npm test
//                        (optionally OLLAMA_MODEL=<model>, default "llama3")
//
// With NO opt-in env var, vitest reports every test here as SKIPPED (not
// failed), the whole suite still passes, and ZERO network calls are made — so
// the default `npm test` stays free (Requirement 13.1/13.2).
//
// When opted in, it drives `synthesize` with a tiny StructuredSummary through
// the REAL default transport (no injected `callProvider`), so the actual Ollama
// `POST {ollamaUrl}/api/generate` path (Requirement 11.4) is exercised, and
// asserts an "ok" AiExplanation whose provider is "ollama".
//
// Gemini and Groq (Requirement 11.5) are intentionally NOT invoked live here:
// their transports require API keys that the CALLER injects via `callProvider`
// (the default transport is deliberately key-free to keep the default path $0).
// A live Gemini/Groq check would therefore need caller-supplied credentials and
// a caller-supplied transport. Additionally, per Requirement 11.6 / 13, if a
// fallback provider would exceed its documented free tier the costguard SKIPS
// it (returning `skipped-free-tier-limit`) rather than proceeding — so even an
// opted-in run never spends past a free tier. That skip/limit behaviour is
// already covered deterministically by the mocked unit test in llm.test.ts.
//
// Requirements: 11.4, 11.5, 11.6, 13.1, 13.2

import { describe, it, expect } from "vitest";
import {
  synthesize,
  defaultLlmConfig,
  type LastInvocationStore,
} from "./llm.js";
import type { StructuredSummary } from "./types.js";

// ---------------------------------------------------------------------------
// Opt-in gate — the ONLY thing that lets this suite make a real network call.
// ---------------------------------------------------------------------------

/**
 * True only when the caller has explicitly opted in AND provided an Ollama URL.
 * When false, `describe.skipIf`/`it.skipIf` mark the cases as skipped and no
 * provider is ever contacted (zero network calls, $0 — Requirement 13).
 */
const OLLAMA_URL = process.env.OLLAMA_URL;
const LIVE_OLLAMA_ENABLED =
  process.env.LLM_INTEGRATION === "1" &&
  typeof OLLAMA_URL === "string" &&
  OLLAMA_URL.length > 0;

/** A fresh in-memory floor store so the 15-minute floor never blocks the run. */
function freshLastInvocation(): LastInvocationStore {
  let value: number | undefined;
  return {
    get: () => value,
    set: (v: number) => {
      value = v;
    },
  };
}

/** A minimal non-empty summary so synthesis proceeds past the empty check. */
function tinySummary(cycleTMs = 0): StructuredSummary {
  return {
    cycleTMs,
    bandCrossings: [
      { metric: "latency_p95", from: "yellow", to: "red", tMs: cycleTMs },
    ],
    spikes: [],
    correlations: [],
    unmonitored: [],
    empty: false,
  };
}

// ---------------------------------------------------------------------------
// Live Ollama connectivity (opt-in only)
// ---------------------------------------------------------------------------

describe.skipIf(!LIVE_OLLAMA_ENABLED)(
  "synthesize — LIVE Ollama connectivity (opt-in; Requirement 11.4)",
  () => {
    it("reaches a real Ollama server and returns an ok explanation from provider 'ollama'", async () => {
      // Real default transport: no injected callProvider, so this hits the
      // actual POST {ollamaUrl}/api/generate path against the opted-in server.
      const cfg = defaultLlmConfig({
        provider: "ollama",
        ollamaUrl: OLLAMA_URL as string,
        ollamaModel: process.env.OLLAMA_MODEL ?? "llama3",
      });

      const result = await synthesize(tinySummary(), cfg, Date.now(), {
        // Deliberately NO callProvider -> exercise the real Ollama transport.
        lastInvocation: freshLastInvocation(),
      });

      expect(result.status).toBe("ok");
      expect(result.provider).toBe("ollama");
      expect(typeof result.hypothesis).toBe("string");
      expect(typeof result.suggestion).toBe("string");
      expect(result.basedOn).toBeDefined();
    });
  },
);

// ---------------------------------------------------------------------------
// Documentation-only guard for the default (no opt-in) path.
// ---------------------------------------------------------------------------

// This always-present case documents and asserts the $0 default: without the
// opt-in env vars the live suite above is skipped and this test confirms the
// gate is closed, so `npm test` makes no LLM network call (Requirement 13).
describe("llm live-connectivity gate (default: disabled)", () => {
  it.skipIf(LIVE_OLLAMA_ENABLED)(
    "is disabled unless LLM_INTEGRATION=1 and OLLAMA_URL are set (stays $0)",
    () => {
      expect(LIVE_OLLAMA_ENABLED).toBe(false);
    },
  );
});
