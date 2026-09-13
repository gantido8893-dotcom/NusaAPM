/**
 * App integration / snapshot test (task 9.4).
 *
 * Verifies the Simple_View wires the five Insight_Service JSON API endpoints
 * together and lays out the cost-notification banner, the health band strip,
 * the complexity card grid, and the AI insight panel all within the SAME view
 * (Requirement 12.4), and that acknowledging a cost notification POSTs to
 * `/api/cost-notifications/:id/ack` and removes it from the view (Req 13.3).
 *
 * `fetch` is stubbed so the test drives real component behaviour end-to-end
 * without a live insight-service. Real timers are used and the component is
 * unmounted at the end so the 30s refresh interval never leaks.
 *
 * Requirements: 12.4, 13.3
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import type { AiExplanation } from "../../services/insight-service/src/types";

// ---------------------------------------------------------------------------
// Mock API payloads
// ---------------------------------------------------------------------------

const COST_NOTIFICATION_ID = "cost-1";

const bandsResponse = {
  metrics: [
    { metric: "http_request_p95_ms", band: "yellow", percentOfCritical: 68 },
    { metric: "process_resident_memory_bytes", band: "green", percentOfCritical: 22 },
  ],
};

const complexityResponse = {
  endpoints: [
    {
      endpoint: "GET /orders",
      time: {
        status: "ok",
        complexityClass: "linear",
        plainLanguage: "scales roughly linearly with load",
        rSquared: 0.94,
        distinctLoadLevels: 6,
      },
      space: {
        status: "insufficient-data",
        distinctLoadLevels: 2,
      },
    },
  ],
};

const runwayResponse = {
  metrics: [
    {
      metric: "http_request_p95_ms",
      runway: {
        status: "ok",
        timeToCriticalMs: 259_200_000,
        humanReadable: "about 3 days",
        slopePerMs: 0.0001,
        dataPoints: 40,
      },
    },
  ],
};

const insightExplanation: AiExplanation = {
  status: "ok",
  provider: "ollama",
  hypothesis:
    "Latency growth on GET /orders aligns with rising connection-pool saturation.",
  suggestion: "Increase the connection-pool size or add a read replica.",
  basedOn: {
    cycleTMs: 1_700_000_000_000,
    bandCrossings: [
      { metric: "http_request_p95_ms", from: "green", to: "yellow", tMs: 1_700_000_000_000 },
    ],
    spikes: [],
    correlations: [],
    unmonitored: [],
    empty: false,
  },
  generatedAtMs: 1_700_000_000_000,
};

const insightResponse = { insight: insightExplanation };

const costNotificationsResponse = {
  notifications: [
    {
      id: COST_NOTIFICATION_ID,
      component: "Grafana Cloud",
      kind: "free-tier-limit-exceeded",
      detail:
        "Metric-series count would exceed the documented free-tier allowance.",
      acknowledged: false,
      raisedAtMs: 1_700_000_000_000,
    },
  ],
};

/** JSON `Response`-like object matching what App's `apiGet`/`apiPost` expect. */
function jsonOk(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

/**
 * Build a `fetch` stub that routes each GET to its mocked payload and returns a
 * 2xx for the POST ack. `postCalls` records the acknowledged paths so the test
 * can assert the correct ack endpoint was hit (Req 13.3).
 */
function makeFetchStub(postCalls: string[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "POST") {
      postCalls.push(url);
      return jsonOk({ ok: true });
    }

    if (url.endsWith("/api/bands")) return jsonOk(bandsResponse);
    if (url.endsWith("/api/complexity")) return jsonOk(complexityResponse);
    if (url.endsWith("/api/runway")) return jsonOk(runwayResponse);
    if (url.endsWith("/api/insight")) return jsonOk(insightResponse);
    if (url.endsWith("/api/cost-notifications"))
      return jsonOk(costNotificationsResponse);

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("App (Simple View integration)", () => {
  it("renders the banner, health bands, complexity cards, and insight panel together (Req 12.4)", async () => {
    const postCalls: string[] = [];
    vi.stubGlobal("fetch", makeFetchStub(postCalls));

    const { unmount } = render(<App />);

    // Cost-notification banner (role="alert").
    const banner = await screen.findByRole("alert", {
      name: /guardrail notifications/i,
    });
    expect(banner).toBeInTheDocument();
    expect(within(banner).getByText(/free-tier limit exceeded/i)).toBeInTheDocument();

    // At least one HealthBand — headings render the metric names.
    expect(
      await screen.findByRole("heading", { name: /http_request_p95_ms/i }),
    ).toBeInTheDocument();
    // Runway humanReadable is joined into the band strip.
    expect(screen.getByText(/about 3 days/i)).toBeInTheDocument();

    // At least one ComplexityCard.
    expect(
      screen.getByRole("heading", { name: /GET \/orders/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/scales roughly linearly with load/i),
    ).toBeInTheDocument();

    // The InsightPanel, rendered alongside the metrics.
    expect(
      screen.getByText(/connection-pool saturation/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("note", { name: /unverified hypothesis/i }),
    ).toBeInTheDocument();

    unmount();
  });

  it("acknowledging a cost notification POSTs the ack and removes it (Req 13.3)", async () => {
    const postCalls: string[] = [];
    vi.stubGlobal("fetch", makeFetchStub(postCalls));

    const { unmount } = render(<App />);

    const ackButton = await screen.findByRole("button", {
      name: /acknowledge/i,
    });

    fireEvent.click(ackButton);

    // POST hit the correct per-notification ack path.
    expect(postCalls).toContainEqual(
      expect.stringContaining(
        `/api/cost-notifications/${COST_NOTIFICATION_ID}/ack`,
      ),
    );

    // The whole banner (and its ack button) is removed from the view after a
    // successful ack — the banner renders nothing when it has no notifications.
    await vi.waitFor(() => {
      expect(
        screen.queryByRole("alert", { name: /guardrail notifications/i }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: /acknowledg/i }),
    ).not.toBeInTheDocument();

    unmount();
  });

  it("matches the loaded-view snapshot", async () => {
    const postCalls: string[] = [];
    vi.stubGlobal("fetch", makeFetchStub(postCalls));

    const { container, unmount } = render(<App />);

    // Wait for every panel to finish loading before snapshotting.
    await screen.findByRole("alert", { name: /guardrail notifications/i });
    await screen.findByRole("heading", { name: /http_request_p95_ms/i });
    await screen.findByRole("heading", { name: /GET \/orders/i });
    await screen.findByText(/connection-pool saturation/i);

    expect(container).toMatchSnapshot();

    unmount();
  });
});
