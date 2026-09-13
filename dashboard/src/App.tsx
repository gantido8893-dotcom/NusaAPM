/**
 * Simple View root component — end-to-end wiring (task 9.3).
 *
 * Fetches the five Insight_Service JSON API endpoints and lays out, all within
 * the SAME view (Requirement 12.4):
 *   - a persistent cost-notification banner at the top that stays until each
 *     notification is acknowledged, with an "Acknowledge" button that POSTs to
 *     `/api/cost-notifications/:id/ack` and removes it (Requirement 13.3);
 *   - a health band strip (one HealthBand per metric), joining each metric's
 *     runway `humanReadable` into its `runwaySummary`;
 *   - a complexity card grid (one ComplexityCard per endpoint);
 *   - the AI InsightPanel, rendered next to the metrics it is based on.
 *
 * Live-data + graceful degradation (Requirements 4.2, 15.3): every panel has
 * its own loading and error state so one failing endpoint never blanks the
 * whole view. Requests refresh on an interval so the view reflects live data.
 *
 * The API base URL is configurable via `VITE_INSIGHT_API_URL`; it defaults to
 * same-origin ("") so the dashboard works behind a reverse proxy, and can be
 * pointed at the local insight-service (e.g. http://localhost:3001) in dev.
 *
 * Requirements: 4.2, 12.4, 13.3, 15.3
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import ComplexityCard, {
  type ComplexityEstimate,
} from "./components/ComplexityCard";
import HealthBand, { type Band } from "./components/HealthBand";
import InsightPanel from "./components/InsightPanel";
import type { AiExplanation } from "../../services/insight-service/src/types";

// ---------------------------------------------------------------------------
// API base URL + response shapes (mirroring services/insight-service/src/api.ts)
// ---------------------------------------------------------------------------

/**
 * Base URL for the Insight_Service JSON API. Empty string = same-origin.
 * `import.meta.env.VITE_INSIGHT_API_URL` overrides it (e.g. in dev pointing at
 * http://localhost:3001). Trailing slashes are trimmed so path joins are clean.
 */
const API_BASE: string = (import.meta.env.VITE_INSIGHT_API_URL ?? "").replace(
  /\/+$/,
  "",
);

/** How often (ms) to refresh live data. */
const REFRESH_MS = 30_000;

interface MetricBand {
  metric: string;
  band: Band;
  percentOfCritical?: number;
}
interface BandsResponse {
  metrics: MetricBand[];
}

interface EndpointComplexity {
  endpoint: string;
  time: ComplexityEstimate;
  space: ComplexityEstimate;
}
interface ComplexityResponse {
  endpoints: EndpointComplexity[];
}

interface RunwayEstimate {
  status: "ok" | "not-trending" | "insufficient-data";
  timeToCriticalMs?: number;
  humanReadable?: string;
  slopePerMs?: number;
  dataPoints: number;
}
interface MetricRunway {
  metric: string;
  runway: RunwayEstimate;
}
interface RunwayResponse {
  metrics: MetricRunway[];
}

interface InsightResponse {
  insight: AiExplanation;
}

interface CostNotification {
  id: string;
  component: string;
  kind: "paid-tier-required" | "free-tier-limit-exceeded";
  detail: string;
  acknowledged: boolean;
  raisedAtMs: number;
}
interface CostNotificationsResponse {
  notifications: CostNotification[];
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

/** Async resource state used by every panel for its own loading/error handling. */
interface Resource<T> {
  data?: T;
  loading: boolean;
  error?: string;
}

const initialResource = <T,>(): Resource<T> => ({ loading: true });

/** GET `path` (relative to {@link API_BASE}) and parse JSON, throwing on non-2xx. */
async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

/** POST `path` (relative to {@link API_BASE}), throwing on non-2xx. */
async function apiPost(path: string): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`POST ${path} failed (${res.status})`);
  }
}

/**
 * Load a single resource into state, tracking loading/error independently so a
 * failure in one endpoint never blanks the others (Requirements 4.2, 15.3).
 */
function useResource<T>(
  path: string,
  refreshMs: number,
): Resource<T> {
  const [state, setState] = useState<Resource<T>>(initialResource<T>());

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    const load = async () => {
      try {
        const data = await apiGet<T>(path, controller.signal);
        if (active) setState({ data, loading: false });
      } catch (err) {
        if (!active || controller.signal.aborted) return;
        setState((prev) => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : "Request failed",
        }));
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), refreshMs);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [path, refreshMs]);

  return state;
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

/** A consistent loading/error/empty wrapper for a panel's async content. */
function PanelState({
  loading,
  error,
  isEmpty,
  emptyLabel,
  children,
}: {
  loading: boolean;
  error?: string;
  isEmpty?: boolean;
  emptyLabel?: string;
  children: React.ReactNode;
}): JSX.Element {
  if (error) {
    return (
      <p className="panel-state panel-state--error" role="alert">
        Couldn’t load live data: {error}
      </p>
    );
  }
  if (loading) {
    return (
      <p className="panel-state panel-state--loading" role="status">
        Loading live data…
      </p>
    );
  }
  if (isEmpty) {
    return (
      <p className="panel-state panel-state--empty" role="status">
        {emptyLabel ?? "No data yet."}
      </p>
    );
  }
  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// Cost-notification banner (Requirement 13.3)
// ---------------------------------------------------------------------------

const COST_KIND_LABEL: Record<CostNotification["kind"], string> = {
  "paid-tier-required": "Paid tier required",
  "free-tier-limit-exceeded": "Free-tier limit exceeded",
};

function CostNotificationBanner({
  notifications,
  onAcknowledge,
  acknowledging,
}: {
  notifications: CostNotification[];
  onAcknowledge: (id: string) => void;
  acknowledging: Set<string>;
}): JSX.Element | null {
  if (notifications.length === 0) return null;
  return (
    <aside
      className="cost-banner"
      role="alert"
      aria-label="Zero-cost guardrail notifications"
    >
      <h2 className="cost-banner__heading">Cost guardrail</h2>
      <ul className="cost-banner__list">
        {notifications.map((n) => (
          <li key={n.id} className="cost-banner__item">
            <div className="cost-banner__text">
              <strong className="cost-banner__kind">
                {COST_KIND_LABEL[n.kind]}
              </strong>{" "}
              <span className="cost-banner__component">{n.component}</span>
              <p className="cost-banner__detail">{n.detail}</p>
            </div>
            <button
              type="button"
              className="cost-banner__ack"
              onClick={() => onAcknowledge(n.id)}
              disabled={acknowledging.has(n.id)}
            >
              {acknowledging.has(n.id) ? "Acknowledging…" : "Acknowledge"}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App(): JSX.Element {
  const bands = useResource<BandsResponse>("/api/bands", REFRESH_MS);
  const complexity = useResource<ComplexityResponse>(
    "/api/complexity",
    REFRESH_MS,
  );
  const runway = useResource<RunwayResponse>("/api/runway", REFRESH_MS);
  const insight = useResource<InsightResponse>("/api/insight", REFRESH_MS);
  const costNotifications = useResource<CostNotificationsResponse>(
    "/api/cost-notifications",
    REFRESH_MS,
  );

  // Locally acknowledged ids are removed from the banner immediately so an
  // acknowledged notification disappears without waiting for the next refresh.
  const [acknowledgedIds, setAcknowledgedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [acknowledging, setAcknowledging] = useState<Set<string>>(
    () => new Set(),
  );

  const handleAcknowledge = useCallback(async (id: string) => {
    setAcknowledging((prev) => new Set(prev).add(id));
    try {
      await apiPost(`/api/cost-notifications/${encodeURIComponent(id)}/ack`);
      setAcknowledgedIds((prev) => new Set(prev).add(id));
    } catch {
      // Leave the notification in place so the user can retry.
    } finally {
      setAcknowledging((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  // Runway summary per metric, joined into the HealthBand strip.
  const runwayByMetric = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of runway.data?.metrics ?? []) {
      if (m.runway.status === "ok" && m.runway.humanReadable) {
        map.set(m.metric, m.runway.humanReadable);
      }
    }
    return map;
  }, [runway.data]);

  const activeNotifications = (
    costNotifications.data?.notifications ?? []
  ).filter((n) => !n.acknowledged && !acknowledgedIds.has(n.id));

  const bandMetrics = bands.data?.metrics ?? [];
  const complexityEndpoints = complexity.data?.endpoints ?? [];

  return (
    <main className="app">
      <header className="app__header">
        <h1>Personal AI-Powered APM</h1>
        <p className="app__subtitle">Simple View</p>
      </header>

      {/* Cost-notification banner — persistent until acknowledged (Req 13.3). */}
      <CostNotificationBanner
        notifications={activeNotifications}
        onAcknowledge={handleAcknowledge}
        acknowledging={acknowledging}
      />

      {/* Health band strip (Req 12.4). */}
      <section className="app__section app__section--bands" aria-label="Health">
        <h2>Health</h2>
        <PanelState
          loading={bands.loading}
          error={bands.error}
          isEmpty={bandMetrics.length === 0}
          emptyLabel="No metrics are being tracked yet."
        >
          <div className="health-band-strip">
            {bandMetrics.map((m) => {
              const runwaySummary = runwayByMetric.get(m.metric);
              return (
                <HealthBand
                  key={m.metric}
                  metric={m.metric}
                  band={m.band}
                  // The /api/bands endpoint reports the classification and
                  // percent-of-critical, not a raw value; show the percentage
                  // as the headline figure when available.
                  value={m.percentOfCritical ?? NaN}
                  {...(m.percentOfCritical !== undefined
                    ? { percentOfCritical: m.percentOfCritical }
                    : {})}
                  {...(runwaySummary ? { runwaySummary } : {})}
                />
              );
            })}
          </div>
        </PanelState>
      </section>

      {/* Complexity card grid (Req 12.4). */}
      <section
        className="app__section app__section--complexity"
        aria-label="Complexity"
      >
        <h2>Complexity</h2>
        <PanelState
          loading={complexity.loading}
          error={complexity.error}
          isEmpty={complexityEndpoints.length === 0}
          emptyLabel="No endpoints are being profiled yet."
        >
          <div className="complexity-grid">
            {complexityEndpoints.map((ep) => (
              <ComplexityCard
                key={ep.endpoint}
                endpoint={ep.endpoint}
                time={ep.time}
                space={ep.space}
              />
            ))}
          </div>
        </PanelState>
      </section>

      {/* AI insight panel — rendered alongside the metrics (Req 12.4). */}
      <section
        className="app__section app__section--insight"
        aria-label="AI insight"
      >
        <h2>AI Insight</h2>
        <PanelState loading={insight.loading} error={insight.error}>
          {insight.data ? (
            <InsightPanel explanation={insight.data.insight} />
          ) : null}
        </PanelState>
      </section>
    </main>
  );
}
