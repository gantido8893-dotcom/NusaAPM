// llm.ts — LLM synthesis client (tier 2) (task 7.6).
//
// Turns a tier-1 `StructuredSummary` into a plain-English hypothesis +
// suggestion using a local/free LLM, on a strict $0/month budget. The design
// contract (design.md "llm.ts — LLM synthesis client (tier 2)", Requirement 11):
//
//   1. Ollama is the DEFAULT provider (Requirement 11.4). It is called at
//      `POST {ollamaUrl}/api/generate` with `stream:false` and `format:"json"`,
//      under a configurable timeout (default 30s) enforced with an
//      AbortController.
//   2. A 15-minute HARD FLOOR gates every invocation (Requirement 11.3): if a
//      cycle would run < `minIntervalMs` (>= 15 min) after the previous
//      provider call, the invocation is deferred and `skipped-rate-limit` is
//      returned without contacting any provider. The last-invocation timestamp
//      is read/written through an injectable store so the floor is testable and
//      can be persisted across process restarts.
//   3. On Ollama timeout or error, fall back to Gemini, then Groq
//      (Requirement 11.5).
//   4. Before invoking a fallback provider, its documented free-tier limit is
//      checked. If the call would exceed it, the provider is SKIPPED, a flag is
//      routed to costguard (`kind: "free-tier-limit-exceeded"`), and
//      `skipped-free-tier-limit` is returned rather than proceeding
//      (Requirements 11.6, 13).
//   5. ONLY the `StructuredSummary` is ever sent to a provider — never raw time
//      series (Requirement 11.2). The summary carries only aggregated findings
//      (band crossings, spikes, correlations), and it is the sole input to the
//      prompt builder.
//
// An empty summary (nothing detected in the cycle) short-circuits to
// `no-findings` without contacting any provider or consuming rate budget.
//
// Provider I/O and the clock/costguard are injected via `SynthesizeDeps` so the
// module is deterministic and free to test (property tests 7.7/7.8 and unit
// tests 7.9 own the tests; this task implements only the module).
//
// Requirements: 11.2, 11.3, 11.4, 11.5, 11.6

import type { AiExplanation, LlmProvider, StructuredSummary } from "./types.js";
import { defaultCostGuard, type CostGuard } from "./costguard.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * A documented free-tier rate limit for a fallback provider. Both bounds are
 * optional; whichever are supplied are enforced. Counts are the number of
 * invocations already made inside the corresponding rolling window.
 */
export interface RateLimit {
  /** Max invocations allowed per minute (e.g. Groq ~30/min). */
  perMinute?: number;
  /** Max invocations allowed per day (e.g. Groq ~1000/day). */
  perDay?: number;
}

/** LLM synthesis configuration (design.md "llm.ts"). */
export interface LlmConfig {
  /** Default provider; "ollama" per Requirement 11.4. */
  provider: LlmProvider;
  /** Base URL for the local Ollama server, e.g. http://localhost:11434. */
  ollamaUrl: string;
  /** Ollama model name, e.g. "llama3". */
  ollamaModel: string;
  /** Per-provider request timeout in ms; default 30000 (Requirement 11.5). */
  timeoutMs: number;
  /** Hard floor between provider invocations in ms; must be >= 15 min (11.3). */
  minIntervalMs: number;
  /** Documented Gemini free-tier limit, checked before falling back (11.6). */
  geminiFreeTierLimit?: RateLimit;
  /** Documented Groq free-tier limit, checked before falling back (11.6). */
  groqFreeTierLimit?: RateLimit;
}

/** Default per-provider request timeout (Requirement 11.5). */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Hard floor between provider invocations (Requirement 11.3). */
export const MIN_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/** A sensible default config; callers override `ollamaModel` etc. as needed. */
export function defaultLlmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "ollama",
    ollamaUrl: "http://localhost:11434",
    ollamaModel: "llama3",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    minIntervalMs: MIN_INTERVAL_MS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Injectable dependencies (clock, provider transport, rate-limit accounting)
// ---------------------------------------------------------------------------

/**
 * A raw provider result. `hypothesis`/`suggestion` are the parsed plain-English
 * fields; a thrown error (including an abort/timeout) signals failure and
 * triggers fallback to the next provider.
 */
export interface ProviderResult {
  hypothesis: string;
  suggestion: string;
}

/**
 * Read/write seam for the last provider-invocation timestamp so the 15-minute
 * floor survives process restarts and is deterministic in tests. Defaults to an
 * in-memory implementation.
 */
export interface LastInvocationStore {
  /** Epoch-ms of the last successful provider invocation, or `undefined`. */
  get(): number | undefined;
  /** Record the epoch-ms of a provider invocation. */
  set(tMs: number): void;
}

/**
 * Read seam for how many fallback-provider invocations have already occurred in
 * the current per-minute / per-day windows, used to compare against the
 * documented free-tier limit BEFORE issuing a call (Requirement 11.6).
 */
export interface FreeTierUsage {
  /** Invocations already made for `provider` in the last minute. */
  perMinute(provider: LlmProvider): number;
  /** Invocations already made for `provider` in the last day. */
  perDay(provider: LlmProvider): number;
}

/** Injected collaborators for {@link synthesize}. All have safe defaults. */
export interface SynthesizeDeps {
  /**
   * Calls a single provider with the (already-built) prompt. Must reject on
   * timeout/error so fallback can proceed. Defaults to a real fetch-based
   * transport (Ollama over HTTP; Gemini/Groq require injected transports since
   * they need API keys the caller owns).
   */
  callProvider?: (
    provider: LlmProvider,
    prompt: string,
    cfg: LlmConfig,
  ) => Promise<ProviderResult>;
  /** Last-invocation timestamp store; defaults to a module-local in-memory one. */
  lastInvocation?: LastInvocationStore;
  /** Free-tier usage accounting; defaults to zero usage (no prior calls). */
  usage?: FreeTierUsage;
  /** Where free-tier-limit flags are routed; defaults to the shared guard. */
  costGuard?: CostGuard;
}

// ---------------------------------------------------------------------------
// Prompt building — the ONLY data sent to a provider is the StructuredSummary
// ---------------------------------------------------------------------------

/**
 * Build the provider prompt from the `StructuredSummary` alone. This function
 * is intentionally the single choke point through which payload data flows to a
 * provider, so it is easy to assert (Property 11) that no raw time series ever
 * reaches the LLM. The summary contains only aggregated findings — band
 * crossings, spikes (mean/stdDev), and correlations — never `Sample` arrays.
 */
export function buildPrompt(summary: StructuredSummary): string {
  const instructions =
    "You are an APM assistant. Given a JSON summary of detected metric " +
    "anomalies, respond with a single JSON object " +
    '{"hypothesis": string, "suggestion": string} proposing the most likely ' +
    "cause and one concrete next step. Treat this as an unverified hypothesis.";
  return `${instructions}\n\nSUMMARY:\n${JSON.stringify(summary)}`;
}

// ---------------------------------------------------------------------------
// synthesize — the tier-2 entry point
// ---------------------------------------------------------------------------

/** Ordered fallback chain after the default provider (Requirement 11.5). */
const FALLBACK_ORDER: LlmProvider[] = ["ollama", "gemini", "groq"];

/**
 * Produce an {@link AiExplanation} for `summary` at time `now` (epoch-ms).
 *
 * See the module header for the full contract. Behaviour by case:
 *  - empty summary            -> `no-findings` (no provider contacted)
 *  - within the 15-min floor  -> `skipped-rate-limit` (no provider contacted)
 *  - a fallback provider that
 *    would exceed its free tier-> route flag to costguard, try the next; if all
 *                                 fallbacks are exhausted this way return
 *                                 `skipped-free-tier-limit`
 *  - first provider that
 *    returns a result         -> `ok` with that provider + hypothesis/suggestion
 *
 * The last-invocation timestamp is stamped only when a provider actually
 * returns a result, so deferred/skipped cycles never advance the floor.
 */
export async function synthesize(
  summary: StructuredSummary,
  cfg: LlmConfig,
  now: number,
  deps: SynthesizeDeps = {},
): Promise<AiExplanation> {
  const callProvider = deps.callProvider ?? defaultCallProvider;
  const lastInvocation = deps.lastInvocation ?? moduleLastInvocation;
  const usage = deps.usage ?? ZERO_USAGE;
  const costGuard = deps.costGuard ?? defaultCostGuard;

  // Nothing detected this cycle: never contact a provider (Requirement 11.1
  // only synthesizes on a recorded finding). This also keeps the rate budget
  // untouched.
  if (summary.empty) {
    return { status: "no-findings", generatedAtMs: now };
  }

  // 15-minute hard floor (Requirement 11.3). A cycle that would run sooner than
  // `minIntervalMs` (never below the 15-min minimum) after the previous
  // provider call is deferred — no provider is contacted.
  const floorMs = Math.max(cfg.minIntervalMs, MIN_INTERVAL_MS);
  const last = lastInvocation.get();
  if (last !== undefined && now - last < floorMs) {
    return { status: "skipped-rate-limit", basedOn: summary, generatedAtMs: now };
  }

  // Only the StructuredSummary is turned into the payload (Requirement 11.2).
  const prompt = buildPrompt(summary);

  // Provider chain: the configured default first, then the remaining providers
  // in the documented fallback order (Requirement 11.5), de-duplicated.
  const chain = orderProviders(cfg.provider);

  let anyFreeTierSkip = false;

  for (const provider of chain) {
    // Ollama is local/free and has no documented free-tier limit to check;
    // fallback providers (Gemini/Groq) are gated by their documented limits
    // BEFORE any call is issued (Requirement 11.6).
    if (provider !== "ollama") {
      const limit = freeTierLimitFor(provider, cfg);
      if (limit !== undefined && wouldExceed(limit, provider, usage)) {
        anyFreeTierSkip = true;
        costGuard.raise({
          id: `llm-free-tier-${provider}`,
          component: "llm",
          kind: "free-tier-limit-exceeded",
          detail:
            `Skipped ${provider}: documented free-tier limit reached ` +
            `(${describeLimit(limit)}). Not proceeding to avoid cost.`,
        });
        // Do not call this provider; try the next in the chain.
        continue;
      }
    }

    try {
      const result = await callProvider(provider, prompt, cfg);
      // A provider returned a result: stamp the floor and report success.
      lastInvocation.set(now);
      return {
        status: "ok",
        provider,
        hypothesis: result.hypothesis,
        suggestion: result.suggestion,
        basedOn: summary,
        generatedAtMs: now,
      };
    } catch {
      // Timeout or error: fall back to the next provider (Requirement 11.5).
      continue;
    }
  }

  // Every remaining provider was skipped because it would exceed its free tier.
  if (anyFreeTierSkip) {
    return {
      status: "skipped-free-tier-limit",
      basedOn: summary,
      generatedAtMs: now,
    };
  }

  // All providers were attempted and errored/timed out with none skipped for
  // free-tier reasons. There is no result to report; surface it as a
  // rate-limit-style skip so the caller neither advances the floor nor
  // fabricates an explanation.
  return { status: "skipped-rate-limit", basedOn: summary, generatedAtMs: now };
}

// ---------------------------------------------------------------------------
// Provider ordering + free-tier helpers
// ---------------------------------------------------------------------------

/** The configured default provider first, then the rest of the fallback order. */
function orderProviders(preferred: LlmProvider): LlmProvider[] {
  return [preferred, ...FALLBACK_ORDER.filter((p) => p !== preferred)];
}

/** The documented free-tier limit configured for a fallback provider, if any. */
function freeTierLimitFor(
  provider: LlmProvider,
  cfg: LlmConfig,
): RateLimit | undefined {
  if (provider === "gemini") return cfg.geminiFreeTierLimit;
  if (provider === "groq") return cfg.groqFreeTierLimit;
  return undefined;
}

/** Whether issuing one more call now would exceed the documented limit. */
function wouldExceed(
  limit: RateLimit,
  provider: LlmProvider,
  usage: FreeTierUsage,
): boolean {
  if (limit.perMinute !== undefined && usage.perMinute(provider) >= limit.perMinute) {
    return true;
  }
  if (limit.perDay !== undefined && usage.perDay(provider) >= limit.perDay) {
    return true;
  }
  return false;
}

/** Human-readable description of a documented limit for the costguard detail. */
function describeLimit(limit: RateLimit): string {
  const parts: string[] = [];
  if (limit.perMinute !== undefined) parts.push(`${limit.perMinute}/min`);
  if (limit.perDay !== undefined) parts.push(`${limit.perDay}/day`);
  return parts.length > 0 ? parts.join(", ") : "unspecified";
}

// ---------------------------------------------------------------------------
// Defaults: in-memory floor store, zero usage, and the real fetch transport
// ---------------------------------------------------------------------------

/** Module-local in-memory floor store used when the caller injects none. */
const moduleLastInvocation: LastInvocationStore = (() => {
  let tMs: number | undefined;
  return {
    get: () => tMs,
    set: (v: number) => {
      tMs = v;
    },
  };
})();

/** Default usage: assume no prior calls, so the free-tier check never blocks. */
const ZERO_USAGE: FreeTierUsage = {
  perMinute: () => 0,
  perDay: () => 0,
};

/**
 * Default provider transport. Ollama is called over HTTP with the documented
 * `POST /api/generate`, `stream:false`, `format:"json"` shape and an
 * AbortController-enforced timeout (Requirements 11.4, 11.5). Gemini and Groq
 * require API keys the caller owns, so the default transport does not call them
 * directly — callers inject a `callProvider` that knows their credentials. This
 * keeps the default path key-free and $0 (Requirement 13).
 */
async function defaultCallProvider(
  provider: LlmProvider,
  prompt: string,
  cfg: LlmConfig,
): Promise<ProviderResult> {
  if (provider === "ollama") {
    return callOllama(prompt, cfg);
  }
  // No built-in transport for keyed providers; treat as an error so the chain
  // moves on (or, if it was the last option, surfaces as a skip).
  throw new Error(
    `No built-in transport for provider "${provider}"; inject callProvider to use it.`,
  );
}

/**
 * Call the local Ollama server. Uses global `fetch` + `AbortController`
 * (available on Node 18+). The response body's `response` field is Ollama's
 * generated text, which — because we requested `format:"json"` — is itself a
 * JSON object we parse for `hypothesis`/`suggestion`.
 */
async function callOllama(prompt: string, cfg: LlmConfig): Promise<ProviderResult> {
  const timeoutMs = cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${trimTrailingSlash(cfg.ollamaUrl)}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.ollamaModel,
        prompt,
        stream: false,
        format: "json",
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Ollama returned HTTP ${res.status}`);
    }
    const body = (await res.json()) as { response?: string };
    return parseProviderText(body.response ?? "");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a provider's JSON text into a {@link ProviderResult}. Throws if the
 * text is not the expected `{hypothesis, suggestion}` object so the caller can
 * fall back to the next provider.
 */
function parseProviderText(text: string): ProviderResult {
  const parsed = JSON.parse(text) as { hypothesis?: unknown; suggestion?: unknown };
  if (typeof parsed.hypothesis !== "string" || typeof parsed.suggestion !== "string") {
    throw new Error("Provider response missing hypothesis/suggestion strings");
  }
  return { hypothesis: parsed.hypothesis, suggestion: parsed.suggestion };
}

/** Drop a single trailing slash so URL joining does not double up. */
function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
