/**
 * Snapshot tests for the ComplexityCard component (task 7.16).
 *
 * Covers the three estimate states the component must render honestly:
 *   - `ok`               — a fitted complexity class, plain-language summary,
 *                          and two-decimal R² fit quality
 *   - `insufficient-data`— an explicit "Not enough data yet" state
 *   - `indeterminate`    — an explicit "No clear fit" state
 *
 * The component must NEVER fabricate a curve when the data does not support
 * one, so the insufficient-data and indeterminate states are surfaced as
 * status messages (role=status) rather than an invented complexity class
 * (Requirements 6.4, 7.4, 9.4).
 *
 * Requirements: 6.4, 7.4, 9.4
 */
import { render, screen } from "@testing-library/react";
import ComplexityCard, { type ComplexityEstimate } from "./ComplexityCard";

const okTime: ComplexityEstimate = {
  status: "ok",
  complexityClass: "linear",
  plainLanguage: "Latency scales roughly linearly with load.",
  rSquared: 0.941,
  distinctLoadLevels: 8,
};

const okSpace: ComplexityEstimate = {
  status: "ok",
  complexityClass: "logarithmic",
  plainLanguage: "Memory grows slowly (logarithmically) as data volume rises.",
  rSquared: 0.8765,
  distinctLoadLevels: 7,
};

const insufficientData: ComplexityEstimate = {
  status: "insufficient-data",
  distinctLoadLevels: 3,
};

const indeterminate: ComplexityEstimate = {
  status: "indeterminate",
  distinctLoadLevels: 6,
};

describe("ComplexityCard", () => {
  it("matches snapshot for an ok time + ok space card", () => {
    const { container } = render(
      <ComplexityCard endpoint="GET /orders" time={okTime} space={okSpace} />
    );

    // The fitted class label, plain-language summary, and two-decimal R² are
    // all rendered for an `ok` estimate.
    expect(screen.getByText("O(n) — linear")).toBeInTheDocument();
    expect(
      screen.getByText("Latency scales roughly linearly with load.")
    ).toBeInTheDocument();
    // R² is formatted to two decimals (0.941 -> "0.94", 0.8765 -> "0.88").
    expect(screen.getByText("0.94")).toBeInTheDocument();
    expect(screen.getByText("O(log n) — logarithmic")).toBeInTheDocument();
    expect(screen.getByText("0.88")).toBeInTheDocument();

    expect(container).toMatchSnapshot();
  });

  it("matches snapshot for the insufficient-data state", () => {
    const { container } = render(
      <ComplexityCard
        endpoint="GET /reports"
        time={insufficientData}
        space={insufficientData}
      />
    );

    // Requirement 9.4: an explicit insufficient-data state (role=status), not
    // a fabricated curve.
    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(2);
    statuses.forEach((status) => {
      expect(status).toHaveTextContent(/not enough data yet/i);
    });
    // No complexity class label is invented.
    expect(screen.queryByText(/O\(/)).not.toBeInTheDocument();

    expect(container).toMatchSnapshot();
  });

  it("matches snapshot for the indeterminate state", () => {
    const { container } = render(
      <ComplexityCard
        endpoint="POST /search"
        time={indeterminate}
        space={indeterminate}
      />
    );

    // Requirements 6.4 / 7.4: no candidate curve fits well enough, so an
    // explicit "No clear fit" state is shown instead of a guessed curve.
    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(2);
    statuses.forEach((status) => {
      expect(status).toHaveTextContent(/no clear fit/i);
    });
    expect(screen.queryByText(/O\(/)).not.toBeInTheDocument();

    expect(container).toMatchSnapshot();
  });
});
