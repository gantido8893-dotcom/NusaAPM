/**
 * ComplexityCard — renders empirical time and space complexity for a single
 * endpoint/app (task 7.15).
 *
 * For each dimension (time, space) it shows the fitted complexity class label,
 * the plain-language description, and the R² fit quality when the estimate is
 * `ok`. When the estimate is `insufficient-data` or `indeterminate` it renders
 * an explicit, honest state instead of fabricating a curve — never invent a
 * complexity when the data does not support one (Requirements 6.1, 7.1, 9.4,
 * 12.4).
 *
 * The `ComplexityEstimate` shape mirrors the Insight_Service data model
 * (design.md "Data Models") and the `/api/complexity` response.
 */

/** Candidate empirical complexity classes, ordered simplest to most complex. */
export type ComplexityClass =
  | "constant"
  | "logarithmic"
  | "linear"
  | "linearithmic"
  | "quadratic";

/** Result of empirical curve fitting for time or space complexity. */
export interface ComplexityEstimate {
  status: "ok" | "insufficient-data" | "indeterminate";
  complexityClass?: ComplexityClass;
  plainLanguage?: string;
  rSquared?: number;
  distinctLoadLevels: number;
}

export interface ComplexityCardProps {
  /** Endpoint or app the estimates describe, e.g. "GET /orders". */
  endpoint: string;
  /** Time-complexity estimate: how p95 latency scales with load. */
  time: ComplexityEstimate;
  /** Space-complexity estimate: how memory RSS scales with data volume. */
  space: ComplexityEstimate;
}

/** Minimum distinct load levels required before a fit is attempted. */
const REQUIRED_LOAD_LEVELS = 5;

/** Human-friendly Big-O style label for each complexity class. */
const CLASS_LABEL: Record<ComplexityClass, string> = {
  constant: "O(1) — constant",
  logarithmic: "O(log n) — logarithmic",
  linear: "O(n) — linear",
  linearithmic: "O(n log n) — linearithmic",
  quadratic: "O(n²) — quadratic",
};

/** Format R² (0–1) as a two-decimal string, e.g. 0.94. */
function formatRSquared(rSquared: number): string {
  return rSquared.toFixed(2);
}

/**
 * Render a single complexity dimension (time or space). Each branch is an
 * explicit, distinct state — `ok` shows the fitted curve, the other two states
 * say plainly that no curve is being reported and why.
 */
function ComplexityDimension({
  label,
  estimate,
}: {
  label: string;
  estimate: ComplexityEstimate;
}): JSX.Element {
  const headingId = `complexity-${label.toLowerCase()}-heading`;

  return (
    <section
      className={`complexity-dimension complexity-dimension--${estimate.status}`}
      aria-labelledby={headingId}
    >
      <h4 id={headingId} className="complexity-dimension__label">
        {label}
      </h4>

      {estimate.status === "ok" ? (
        <dl className="complexity-dimension__fit">
          <div>
            <dt>Complexity</dt>
            <dd className="complexity-dimension__class">
              {estimate.complexityClass
                ? CLASS_LABEL[estimate.complexityClass]
                : "—"}
            </dd>
          </div>
          {estimate.plainLanguage ? (
            <div>
              <dt>In plain language</dt>
              <dd className="complexity-dimension__plain">
                {estimate.plainLanguage}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Fit quality (R²)</dt>
            <dd className="complexity-dimension__r2">
              {typeof estimate.rSquared === "number"
                ? formatRSquared(estimate.rSquared)
                : "—"}
            </dd>
          </div>
        </dl>
      ) : estimate.status === "insufficient-data" ? (
        <p className="complexity-dimension__state" role="status">
          Not enough data yet. Recorded {estimate.distinctLoadLevels} distinct
          load {estimate.distinctLoadLevels === 1 ? "level" : "levels"}; need at
          least {REQUIRED_LOAD_LEVELS} before a complexity estimate can be
          fitted.
        </p>
      ) : (
        <p className="complexity-dimension__state" role="status">
          No clear fit. The measurements do not match any known complexity curve
          well enough to report one.
        </p>
      )}
    </section>
  );
}

/**
 * Card showing the time and space complexity for one endpoint/app.
 */
export default function ComplexityCard({
  endpoint,
  time,
  space,
}: ComplexityCardProps): JSX.Element {
  const headingId = `complexity-card-${endpoint
    .replace(/\s+/g, "-")
    .toLowerCase()}`;

  return (
    <article className="complexity-card" aria-labelledby={headingId}>
      <h3 id={headingId} className="complexity-card__endpoint">
        {endpoint}
      </h3>
      <ComplexityDimension label="Time" estimate={time} />
      <ComplexityDimension label="Space" estimate={space} />
    </article>
  );
}
