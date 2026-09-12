// Shared data-model types for the Insight Service.
//
// These are the cross-module data models specified in design.md ("Data Models"
// and "Components and Interfaces"). They are defined once here so that
// thresholds.ts, complexity.ts, forecast.ts, promql.ts, rules.ts, llm.ts,
// scheduler.ts, and costguard.ts share a single source of truth (task 1.2).
//
// Requirements: 2.1, 3.1, 6.2, 7.2, 8.1, 10.5, 11.2, 13.1

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** A single time-series sample. */
export interface Sample {
  tMs: number;
  value: number;
}

// ---------------------------------------------------------------------------
// Threshold band configuration (thresholds.ts)
// ---------------------------------------------------------------------------

/** Green/yellow/red band classification, or `unknown` when no/invalid config. */
export type Band = "green" | "yellow" | "red" | "unknown";

/** Half-open range `[min, max)`. */
export interface BandRange {
  min: number;
  max: number;
}

/** Green/yellow/red bands for a single metric; `red` is the Critical_Range. */
export interface MetricThreshold {
  metric: string;
  green: BandRange;
  yellow: BandRange;
  red: BandRange;
}

/** Threshold configuration for all monitored metrics. */
export interface ThresholdConfig {
  metrics: Record<string, MetricThreshold>;
}

// ---------------------------------------------------------------------------
// Complexity estimate result (complexity.ts)
// ---------------------------------------------------------------------------

/** Candidate empirical complexity classes, ordered simplest to most complex. */
export type ComplexityClass =
  | "constant"
  | "logarithmic"
  | "linear"
  | "linearithmic"
  | "quadratic";

/** A single `(load, value)` observation; `value` is p95 latency or memory RSS. */
export interface FitInput {
  load: number;
  value: number;
}

/** Result of empirical curve fitting for time or space complexity. */
export interface ComplexityEstimate {
  status: "ok" | "insufficient-data" | "indeterminate";
  complexityClass?: ComplexityClass;
  plainLanguage?: string;
  rSquared?: number;
  distinctLoadLevels: number;
}

// ---------------------------------------------------------------------------
// Runway estimate result (forecast.ts)
// ---------------------------------------------------------------------------

/** Inputs to the linear trend / runway-to-critical calculation. */
export interface ForecastInput {
  history: Sample[];
  redBandStart: number;
  lookbackMs: number;
  horizonMs: number;
  approachFromBelow: boolean;
}

/** Result of the runway-to-critical forecast. */
export interface RunwayEstimate {
  status: "ok" | "not-trending" | "insufficient-data";
  timeToCriticalMs?: number;
  humanReadable?: string;
  slopePerMs?: number;
  dataPoints: number;
}

// ---------------------------------------------------------------------------
// Rule-based findings -> structured summary (rules.ts)
// ---------------------------------------------------------------------------

/** A metric transitioning from one band into a higher-severity band. */
export interface BandCrossing {
  metric: string;
  from: Band;
  to: Band;
  tMs: number;
}

/** A value deviating from its baseline-window mean beyond the configured bound. */
export interface SpikeEvent {
  metric: string;
  value: number;
  mean: number;
  stdDev: number;
  tMs: number;
}

/** Two metrics entering higher-severity bands within the correlation window. */
export interface Correlation {
  metricA: string;
  metricB: string;
  withinMs: number;
}

/**
 * Tier-1 findings for a cycle. This is the only payload passed to the LLM
 * (never raw time series) — Requirement 11.2.
 */
export interface StructuredSummary {
  cycleTMs: number;
  bandCrossings: BandCrossing[];
  spikes: SpikeEvent[];
  correlations: Correlation[];
  unmonitored: string[];
  empty: boolean;
}

// ---------------------------------------------------------------------------
// AI explanation (llm.ts) — carries evidence for side-by-side display
// ---------------------------------------------------------------------------

/** LLM provider used for tier-2 synthesis; Ollama is the default. */
export type LlmProvider = "ollama" | "gemini" | "groq";

/** A plain-English hypothesis + suggestion, carrying the evidence it was based on. */
export interface AiExplanation {
  status: "ok" | "skipped-rate-limit" | "skipped-free-tier-limit" | "no-findings";
  provider?: LlmProvider;
  hypothesis?: string;
  suggestion?: string;
  basedOn?: StructuredSummary;
  generatedAtMs: number;
}

// ---------------------------------------------------------------------------
// Zero-cost guardrail (costguard.ts)
// ---------------------------------------------------------------------------

/**
 * A user-visible notification raised when a component would require a paid tier
 * or exceed a documented free-tier limit — Requirement 13.1.
 */
export interface CostNotification {
  id: string;
  component: string;
  kind: "paid-tier-required" | "free-tier-limit-exceeded";
  detail: string;
  acknowledged: boolean;
  raisedAtMs: number;
}
