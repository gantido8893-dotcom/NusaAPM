/**
 * Snapshot tests for the HealthBand component (task 7.14).
 *
 * Covers each band state (green/yellow/red/unknown) plus a state carrying a
 * runway-to-critical summary. The `unknown` case additionally asserts the
 * visible "threshold missing/invalid" indicator per Requirement 3.3, and the
 * component participates in the Simple_View health band strip (Requirement
 * 12.4).
 *
 * Requirements: 3.3, 12.4
 */
import { render, screen } from "@testing-library/react";
import HealthBand from "./HealthBand";

describe("HealthBand", () => {
  it("matches snapshot for the green (Healthy) band", () => {
    const { container } = render(
      <HealthBand
        metric="http_request_p95_ms"
        band="green"
        value={42}
        percentOfCritical={21}
      />
    );
    expect(screen.getByTestId("health-band-badge")).toHaveTextContent("Healthy");
    expect(container).toMatchSnapshot();
  });

  it("matches snapshot for the yellow (Warning) band", () => {
    const { container } = render(
      <HealthBand
        metric="http_request_p95_ms"
        band="yellow"
        value={180}
        percentOfCritical={72}
      />
    );
    expect(screen.getByTestId("health-band-badge")).toHaveTextContent("Warning");
    expect(container).toMatchSnapshot();
  });

  it("matches snapshot for the red (Critical) band", () => {
    const { container } = render(
      <HealthBand
        metric="http_request_p95_ms"
        band="red"
        value={520}
        percentOfCritical={104}
      />
    );
    expect(screen.getByTestId("health-band-badge")).toHaveTextContent("Critical");
    expect(container).toMatchSnapshot();
  });

  it("matches snapshot for the unknown band with the missing/invalid indicator", () => {
    const { container } = render(
      <HealthBand metric="http_request_p95_ms" band="unknown" value={99} />
    );

    // Requirement 3.3: an unknown band surfaces a visible threshold
    // missing/invalid indicator (role=alert) instead of a coloured band.
    const indicator = screen.getByTestId("health-band-threshold-missing");
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveTextContent(/threshold missing\/invalid/i);
    expect(indicator).toHaveAttribute("role", "alert");
    // The percent-of-critical readout is suppressed while the band is unknown.
    expect(screen.queryByTestId("health-band-percent")).not.toBeInTheDocument();

    expect(container).toMatchSnapshot();
  });

  it("matches snapshot when a runway-to-critical summary is present", () => {
    const { container } = render(
      <HealthBand
        metric="process_resident_memory_bytes"
        band="yellow"
        value={640}
        percentOfCritical={80}
        runwaySummary="about 3 days"
      />
    );

    const runway = screen.getByTestId("health-band-runway");
    expect(runway).toHaveTextContent("about 3 days");
    expect(container).toMatchSnapshot();
  });
});
