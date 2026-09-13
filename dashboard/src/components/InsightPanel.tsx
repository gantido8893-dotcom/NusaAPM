/**
 * InsightPanel — presents an AI_Explanation next to the evidence that produced
 * it (task 7.17).
 *
 * Behavior (design.md "InsightPanel.tsx", Requirement 12):
 * - When `status === "ok"` with supporting evidence, render the hypothesis and
 *   suggestion NEXT TO the `basedOn` StructuredSummary evidence — band
 *   crossings, spikes, correlations, and their metric values — within the same
 *   view, no navigation required (Requirement 12.1).
 * - A persistent, always-visible badge marks the explanation as an *unverified
 *   hypothesis* (Requirement 12.2).
 * - If the supporting metrics are unavailable (no `basedOn`, or it carries no
 *   evidence), SUPPRESS the explanation and show "supporting metrics
 *   unavailable" (Requirement 12.3).
 * - `skipped-rate-limit` / `skipped-free-tier-limit` / `no-findings` render an
 *   explanatory note instead of an explanation.
 *
 * The LLM output is a hypothesis, never a verified fact, so the badge is
 * rendered independently of the explanation content and can never be dismissed.
 *
 * Requirements: 12.1, 12.2, 12.3
 */
import type {
  AiExplanation,
  BandCrossing,
  Correlation,
  SpikeEvent,
  StructuredSummary,
} from "../../../services/insight-service/src/types";

export interface InsightPanelProps {
  explanation: AiExplanation;
}

/** Human-readable notes for the non-`ok` statuses. */
const SKIPPED_NOTES: Record<
  Exclude<AiExplanation["status"], "ok">,
  string
> = {
  "skipped-rate-limit":
    "AI insight was skipped this cycle to respect the 15-minute minimum between LLM calls.",
  "skipped-free-tier-limit":
    "AI insight was skipped because the fallback LLM provider would have exceeded its documented free-tier limit.",
  "no-findings":
    "No band crossings or correlated anomalies were detected this cycle, so no AI insight was generated.",
};

/**
 * Evidence is present only when a `basedOn` summary exists and it actually
 * carries at least one finding. An `empty` summary (or one with no crossings,
 * spikes, or correlations) means the supporting metrics are unavailable.
 */
function hasEvidence(summary: StructuredSummary | undefined): summary is StructuredSummary {
  if (!summary || summary.empty) {
    return false;
  }
  return (
    summary.bandCrossings.length > 0 ||
    summary.spikes.length > 0 ||
    summary.correlations.length > 0
  );
}

/** The persistent, non-dismissible "unverified hypothesis" badge (Req 12.2). */
function UnverifiedBadge(): JSX.Element {
  return (
    <span
      className="insight-panel__badge"
      role="note"
      aria-label="This AI explanation is an unverified hypothesis"
      title="AI explanations are hypotheses, not verified facts"
    >
      Unverified hypothesis
    </span>
  );
}

function BandCrossingItem({ crossing }: { crossing: BandCrossing }): JSX.Element {
  return (
    <li className="insight-panel__evidence-item">
      <span className="insight-panel__metric">{crossing.metric}</span> crossed
      from <span className="insight-panel__band">{crossing.from}</span> to{" "}
      <span className="insight-panel__band">{crossing.to}</span>
    </li>
  );
}

function SpikeItem({ spike }: { spike: SpikeEvent }): JSX.Element {
  return (
    <li className="insight-panel__evidence-item">
      <span className="insight-panel__metric">{spike.metric}</span> spiked to{" "}
      <span className="insight-panel__value">{spike.value}</span> (baseline mean{" "}
      <span className="insight-panel__value">{spike.mean}</span>, σ{" "}
      <span className="insight-panel__value">{spike.stdDev}</span>)
    </li>
  );
}

function CorrelationItem({ correlation }: { correlation: Correlation }): JSX.Element {
  return (
    <li className="insight-panel__evidence-item">
      <span className="insight-panel__metric">{correlation.metricA}</span> and{" "}
      <span className="insight-panel__metric">{correlation.metricB}</span> moved
      together within{" "}
      <span className="insight-panel__value">{correlation.withinMs}</span> ms
    </li>
  );
}

/** Renders the `basedOn` StructuredSummary as the supporting-metrics evidence. */
function Evidence({ summary }: { summary: StructuredSummary }): JSX.Element {
  return (
    <section
      className="insight-panel__evidence"
      aria-label="Supporting metrics"
    >
      <h4 className="insight-panel__evidence-heading">Supporting metrics</h4>

      {summary.bandCrossings.length > 0 && (
        <div className="insight-panel__evidence-group">
          <h5>Band crossings</h5>
          <ul>
            {summary.bandCrossings.map((crossing, i) => (
              <BandCrossingItem key={`crossing-${i}`} crossing={crossing} />
            ))}
          </ul>
        </div>
      )}

      {summary.spikes.length > 0 && (
        <div className="insight-panel__evidence-group">
          <h5>Spikes</h5>
          <ul>
            {summary.spikes.map((spike, i) => (
              <SpikeItem key={`spike-${i}`} spike={spike} />
            ))}
          </ul>
        </div>
      )}

      {summary.correlations.length > 0 && (
        <div className="insight-panel__evidence-group">
          <h5>Correlations</h5>
          <ul>
            {summary.correlations.map((correlation, i) => (
              <CorrelationItem key={`correlation-${i}`} correlation={correlation} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export default function InsightPanel({
  explanation,
}: InsightPanelProps): JSX.Element {
  const { status } = explanation;

  // Non-`ok` statuses never carry an explanation: render an explanatory note.
  if (status !== "ok") {
    return (
      <section
        className="insight-panel insight-panel--skipped"
        aria-label="AI insight"
      >
        <header className="insight-panel__header">
          <h3>AI Insight</h3>
          <UnverifiedBadge />
        </header>
        <p className="insight-panel__note" role="status">
          {SKIPPED_NOTES[status]}
        </p>
      </section>
    );
  }

  // status === "ok": the explanation may only be shown next to its evidence.
  // If the supporting metrics are unavailable, suppress it (Requirement 12.3).
  if (!hasEvidence(explanation.basedOn)) {
    return (
      <section
        className="insight-panel insight-panel--unavailable"
        aria-label="AI insight"
      >
        <header className="insight-panel__header">
          <h3>AI Insight</h3>
          <UnverifiedBadge />
        </header>
        <p className="insight-panel__note" role="status">
          Supporting metrics unavailable — AI explanation hidden until the
          metrics that produced it can be shown alongside it.
        </p>
      </section>
    );
  }

  // Explanation + evidence rendered side by side within the same view.
  return (
    <section className="insight-panel insight-panel--ok" aria-label="AI insight">
      <header className="insight-panel__header">
        <h3>AI Insight</h3>
        <UnverifiedBadge />
      </header>

      <div className="insight-panel__body">
        <section
          className="insight-panel__explanation"
          aria-label="AI explanation"
        >
          {explanation.provider && (
            <p className="insight-panel__provider">
              Generated by <span>{explanation.provider}</span>
            </p>
          )}
          {explanation.hypothesis && (
            <div className="insight-panel__hypothesis">
              <h4>Hypothesis</h4>
              <p>{explanation.hypothesis}</p>
            </div>
          )}
          {explanation.suggestion && (
            <div className="insight-panel__suggestion">
              <h4>Suggestion</h4>
              <p>{explanation.suggestion}</p>
            </div>
          )}
        </section>

        <Evidence summary={explanation.basedOn} />
      </div>
    </section>
  );
}
