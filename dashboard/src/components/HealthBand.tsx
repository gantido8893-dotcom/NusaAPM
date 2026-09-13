/**
 * HealthBand — renders a single metric's current health band (task 7.13).
 *
 * Displays a metric's current classification (green/yellow/red/unknown), its
 * observed value, and — when a runway-to-critical estimate exists — the
 * human-readable runway summary alongside it. When the band is `unknown`
 * (threshold configuration missing or invalid), it surfaces a visible
 * "threshold missing/invalid" indicator rather than a coloured band, per
 * Requirement 3.3. This is one of the components that make up the Simple_View
 * health band strip (Requirement 12.4).
 *
 * This is a presentation-only component; data is fetched and laid out by
 * App.tsx (task 9.3).
 *
 * Requirements: 3.3, 12.4
 */

/** Band classification, mirroring the Insight_Service `Band` type. */
export type Band = "green" | "yellow" | "red" | "unknown";

export interface HealthBandProps {
  /** The tracked metric's name (e.g. "http_request_p95_ms"). */
  metric: string;
  /** Current band classification for the metric's latest value. */
  band: Band;
  /** The metric's current observed value. */
  value: number;
  /**
   * Percentage of the critical (red) threshold currently used. Present only
   * when a critical band is configured for the metric; otherwise omitted.
   */
  percentOfCritical?: number;
  /**
   * Human-readable runway-to-critical summary (e.g. "about 3 days"), present
   * only when a runway estimate exists for this metric.
   */
  runwaySummary?: string;
}

/** Human-friendly label shown for each band. */
const BAND_LABEL: Record<Band, string> = {
  green: "Healthy",
  yellow: "Warning",
  red: "Critical",
  unknown: "Unknown",
};

/**
 * Renders a metric's health band. Uses semantic markup and ARIA so the band
 * state is conveyed without relying on colour alone (accessibility).
 */
export function HealthBand({
  metric,
  band,
  value,
  percentOfCritical,
  runwaySummary,
}: HealthBandProps): JSX.Element {
  const isUnknown = band === "unknown";
  const label = BAND_LABEL[band];

  return (
    <section
      className={`health-band health-band--${band}`}
      data-band={band}
      aria-labelledby={`health-band-${metric}-name`}
    >
      <h3 id={`health-band-${metric}-name`} className="health-band__metric">
        {metric}
      </h3>

      <p
        className="health-band__status"
        role="status"
        // Announce band and value together so colour is never the only cue.
        aria-label={`${metric} is ${label}, current value ${value}`}
      >
        <span
          className={`health-band__badge health-band__badge--${band}`}
          data-testid="health-band-badge"
        >
          {label}
        </span>
        <span className="health-band__value" data-testid="health-band-value">
          {value}
        </span>
      </p>

      {isUnknown ? (
        <p className="health-band__warning" role="alert" data-testid="health-band-threshold-missing">
          Threshold missing/invalid
        </p>
      ) : (
        typeof percentOfCritical === "number" && (
          <p className="health-band__percent" data-testid="health-band-percent">
            {percentOfCritical}% of critical
          </p>
        )
      )}

      {runwaySummary && (
        <p className="health-band__runway" data-testid="health-band-runway">
          <span className="health-band__runway-label">Time to critical:</span>{" "}
          {runwaySummary}
        </p>
      )}
    </section>
  );
}

export default HealthBand;
