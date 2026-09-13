// scheduler.ts — two-tier insight cycle scheduler (task 7.11).
//
// Drives the two-tier AI-insight loop described in design.md ("scheduler.ts —
// two-tier insight cycle") and AGENTS.md ("AI Insight Layer"):
//
//   Tier 1 (always-on, instant, free): run `analyze` (rules.ts) EVERY cycle.
//     The tier-1 pass is also exposed on demand (`runTier1`) so the API / other
//     callers can trigger a fresh rule-based pass without waiting for the timer
//     (Requirement 10.1).
//   Tier 2 (rate-limited, occasional): run `synthesize` (llm.ts) on the
//     15–30 min schedule ONLY when tier-1 recorded a band crossing OR a
//     correlated anomaly — i.e. `summary.bandCrossings.length > 0 ||
//     summary.correlations.length > 0` (Requirements 11.1, 11.3). The llm module
//     additionally enforces its own 15-minute hard floor, so even if the cycle
//     cadence were misconfigured below 15 min, `synthesize` defers rather than
//     over-calling a provider.
//
// The latest tier-2 `AiExplanation` (carrying its `basedOn` StructuredSummary
// evidence) is stored so the JSON API can read it: this module exposes a
// `latest()` that satisfies api.ts's `InsightSource` seam, letting `index.ts`
// wire the scheduler straight into `createApp` without an adapter.
//
// Every side-effecting collaborator is injected so the scheduler is
// deterministic and free to unit-test (task 7.12 owns the tests):
//   - `collect`   gathers this cycle's analyze inputs (current samples, prior
//                 bands, baselines, threshold config) — the only place that
//                 touches Prometheus/thresholds, so tests supply a stub.
//   - `analyze`   defaults to rules.ts `analyze` but is overridable.
//   - `synthesize`defaults to llm.ts `synthesize` but is overridable.
//   - `now`       clock, defaults to `Date.now`.
//   - `setTimer` / `clearTimer` scheduling seam, defaults to
//                 `setInterval` / `clearInterval`; tests inject a manual tick.
//
// Requirements: 10.1, 11.1, 11.3

import type { InsightSource } from "./api.js";
import { analyze as defaultAnalyze, type RuleOptions } from "./rules.js";
import { synthesize as defaultSynthesize, type LlmConfig } from "./llm.js";
import type {
  AiExplanation,
  Band,
  Sample,
  StructuredSummary,
  ThresholdConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Cycle cadence bounds (design.md: "insightCycleMs: 15..30 min")
// ---------------------------------------------------------------------------

/** Minimum insight-cycle cadence: 15 minutes (design.md 15..30 min). */
export const MIN_INSIGHT_CYCLE_MS = 15 * 60 * 1000;

/** Maximum insight-cycle cadence: 30 minutes (design.md 15..30 min). */
export const MAX_INSIGHT_CYCLE_MS = 30 * 60 * 1000;

/** Default insight-cycle cadence when none is supplied: 15 minutes. */
export const DEFAULT_INSIGHT_CYCLE_MS = MIN_INSIGHT_CYCLE_MS;

/** Clamp a requested cadence into the documented 15..30 min range. */
export function clampInsightCycleMs(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_INSIGHT_CYCLE_MS;
  return Math.min(MAX_INSIGHT_CYCLE_MS, Math.max(MIN_INSIGHT_CYCLE_MS, ms));
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Scheduler configuration (design.md "scheduler.ts"). */
export interface SchedulerConfig {
  /**
   * Insight-cycle cadence in ms. Clamped to the documented 15..30 min range so
   * a misconfigured value can never drive the LLM tier faster than its floor.
   */
  insightCycleMs: number;
  /** LLM synthesis configuration passed straight to {@link defaultSynthesize}. */
  llm: LlmConfig;
  /** Optional tier-1 rule tuning knobs forwarded to `analyze`. */
  ruleOptions?: RuleOptions;
}

// ---------------------------------------------------------------------------
// Injectable collaborators
// ---------------------------------------------------------------------------

/**
 * The inputs a single tier-1 pass needs. `collect` produces these each cycle;
 * it is the sole seam that touches live data (Prometheus + the threshold
 * store), keeping the scheduler itself pure and testable.
 */
export interface CycleInputs {
  current: Record<string, Sample>;
  previousBands: Record<string, Band>;
  baselines: Record<string, Sample[]>;
  cfg: ThresholdConfig;
}

/** Signature of the tier-1 analyzer (defaults to rules.ts `analyze`). */
export type AnalyzeFn = (
  current: Record<string, Sample>,
  previousBands: Record<string, Band>,
  baselines: Record<string, Sample[]>,
  cfg: ThresholdConfig,
  opts?: RuleOptions,
) => StructuredSummary;

/** Signature of the tier-2 synthesizer (defaults to llm.ts `synthesize`). */
export type SynthesizeFn = (
  summary: StructuredSummary,
  cfg: LlmConfig,
  now: number,
) => Promise<AiExplanation>;

/** A cancel handle for the scheduling seam. */
export type TimerHandle = unknown;

/** Injected collaborators for {@link startScheduler}. Only `collect` is required. */
export interface SchedulerDeps {
  /**
   * Gather this cycle's analyze inputs. The only data-touching seam; a stub in
   * tests, a Prometheus/threshold-backed implementation in production.
   */
  collect: () => Promise<CycleInputs> | CycleInputs;
  /** Tier-1 analyzer; defaults to rules.ts `analyze`. */
  analyze?: AnalyzeFn;
  /** Tier-2 synthesizer; defaults to llm.ts `synthesize`. */
  synthesize?: SynthesizeFn;
  /** Clock, injectable for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Schedule a repeating callback every `ms`; defaults to `setInterval`. Tests
   * inject a manual tick by capturing the callback and invoking it directly.
   */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  /** Cancel a handle from {@link setTimer}; defaults to `clearInterval`. */
  clearTimer?: (handle: TimerHandle) => void;
  /**
   * Optional error sink for a cycle that throws (e.g. `collect` rejects). By
   * default cycle errors are swallowed so one bad cycle never crashes the loop
   * or the HTTP server; inject to observe them in tests/diagnostics.
   */
  onError?: (err: unknown) => void;
}

// ---------------------------------------------------------------------------
// Controller returned by startScheduler
// ---------------------------------------------------------------------------

/**
 * The running scheduler. It IS an {@link InsightSource} (so api.ts can consume
 * it directly), plus:
 *   - `stop()`      cancels the timer (design.md's `Stop`).
 *   - `runCycle()`  runs one full cycle (tier-1 always; tier-2 on a finding);
 *                   awaitable so tests can drive cycles deterministically.
 *   - `runTier1()`  runs tier-1 only, on demand (Requirement 10.1), returning
 *                   the fresh StructuredSummary without touching tier-2.
 *   - `latestSummary()` the most recent tier-1 summary, for the API/diagnostics.
 */
export interface Scheduler extends InsightSource {
  /** The latest tier-2 explanation, or `undefined` until one is produced. */
  latest(): AiExplanation | undefined;
  /** The latest tier-1 summary, or `undefined` until the first cycle runs. */
  latestSummary(): StructuredSummary | undefined;
  /** Run tier-1 analysis on demand (no tier-2). */
  runTier1(): Promise<StructuredSummary>;
  /** Run one full cycle (tier-1, then tier-2 iff a finding was recorded). */
  runCycle(): Promise<void>;
  /** Stop the periodic timer. Idempotent. */
  stop(): void;
}

/** design.md names the stop handle `Stop`. */
export type Stop = Scheduler;

// ---------------------------------------------------------------------------
// Finding predicate
// ---------------------------------------------------------------------------

/**
 * Whether a tier-1 summary warrants a tier-2 LLM synthesis this cycle. Per
 * Requirement 11.1 the LLM tier runs ONLY on a recorded band crossing or a
 * correlated anomaly — spikes and `unmonitored` notes alone do not escalate.
 */
export function hasEscalatableFinding(summary: StructuredSummary): boolean {
  return summary.bandCrossings.length > 0 || summary.correlations.length > 0;
}

// ---------------------------------------------------------------------------
// startScheduler — the entry point
// ---------------------------------------------------------------------------

/**
 * Start the two-tier insight loop and return its {@link Scheduler} controller.
 *
 * Behaviour per cycle:
 *   1. `collect()` gathers the cycle inputs.
 *   2. tier-1 `analyze` runs and its summary is stored (`latestSummary`).
 *   3. tier-2 `synthesize` runs ONLY when {@link hasEscalatableFinding} is true.
 *      Its result is stored as `latest()` for the API — but only when it is a
 *      usable explanation (`ok`); `skipped-*` / `no-findings` results from the
 *      llm floor do not overwrite a previously good explanation, so the API
 *      keeps showing the last real insight alongside its evidence rather than
 *      flapping to an empty state between provider calls.
 *
 * The timer fires `runCycle` every `insightCycleMs` (clamped to 15..30 min). A
 * cycle that throws is routed to `onError` (default: swallowed) so the loop and
 * the HTTP server survive a transient Prometheus/LLM failure.
 */
export function startScheduler(
  deps: SchedulerDeps,
  cfg: SchedulerConfig,
): Scheduler {
  const analyzeFn = deps.analyze ?? defaultAnalyze;
  const synthesizeFn = deps.synthesize ?? defaultSynthesize;
  const now = deps.now ?? (() => Date.now());
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number): TimerHandle => setInterval(fn, ms));
  const clearTimer =
    deps.clearTimer ??
    ((handle: TimerHandle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const onError = deps.onError ?? (() => {});

  const cycleMs = clampInsightCycleMs(cfg.insightCycleMs);

  let latestExplanation: AiExplanation | undefined;
  let latestSummary: StructuredSummary | undefined;
  let timer: TimerHandle | undefined;
  let stopped = false;

  async function runTier1(): Promise<StructuredSummary> {
    const inputs = await deps.collect();
    const summary = analyzeFn(
      inputs.current,
      inputs.previousBands,
      inputs.baselines,
      inputs.cfg,
      cfg.ruleOptions,
    );
    latestSummary = summary;
    return summary;
  }

  async function runCycle(): Promise<void> {
    const summary = await runTier1();

    // Tier-2 escalates only on a band crossing or a correlated anomaly
    // (Requirement 11.1). Nothing to synthesize otherwise.
    if (!hasEscalatableFinding(summary)) {
      return;
    }

    const explanation = await synthesizeFn(summary, cfg.llm, now());

    // Store the explanation with its evidence for the API. Only a usable
    // explanation replaces the last one — a `skipped-*` result (e.g. the llm
    // 15-min floor deferred the call) must not clobber a prior good insight.
    if (explanation.status === "ok") {
      latestExplanation = explanation;
    } else if (latestExplanation === undefined) {
      // No prior insight to preserve: surface the skip/no-findings state so the
      // API returns a well-formed shape rather than nothing.
      latestExplanation = explanation;
    }
  }

  /** Run a cycle, funnelling any failure to `onError` so the loop survives. */
  function safeRunCycle(): void {
    void Promise.resolve()
      .then(() => runCycle())
      .catch(onError);
  }

  timer = setTimer(safeRunCycle, cycleMs);

  return {
    latest: () => latestExplanation,
    latestSummary: () => latestSummary,
    runTier1,
    runCycle,
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
    },
  };
}
