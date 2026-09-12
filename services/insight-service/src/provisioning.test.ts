// Feature: personal-ai-apm-system — Task 1.10
// Snapshot / schema tests for Grafana provisioning: the Prometheus datasource
// and the three dashboard JSON files (latency, error-rate, CPU-and-memory).
//
// Validates:
//   Requirement 4.1 — Grafana provisions a Prometheus datasource and a latency,
//                      an error-rate, and a CPU-and-memory dashboard.
//   Requirement 4.3 — each dashboard refreshes at an interval <= 60 seconds.
//   Requirement 4.4 — each dashboard panel defines a no-data state so a missing
//                      metric shows "no data" while other panels remain.
//
// YAML is parsed with js-yaml (free OSS). Dashboard JSON is parsed with the
// built-in JSON parser. No live Grafana is required — these are static-config
// assertions so the test stays free and deterministic (Requirement 13).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { load as parseYaml } from "js-yaml";
import { describe, it, expect } from "vitest";

// Resolve the grafana/provisioning directory relative to this test file
// (services/insight-service/src/ -> ../../../grafana/provisioning).
const here = dirname(fileURLToPath(import.meta.url));
const provisioningDir = resolve(here, "..", "..", "..", "grafana", "provisioning");

const datasourceFile = resolve(provisioningDir, "datasources", "prometheus.yml");
const dashboardsProviderFile = resolve(provisioningDir, "dashboards", "dashboards.yml");
const dashboardFiles = {
  latency: resolve(provisioningDir, "dashboards", "latency.json"),
  "error-rate": resolve(provisioningDir, "dashboards", "error-rate.json"),
  "cpu-and-memory": resolve(provisioningDir, "dashboards", "cpu-and-memory.json"),
};

function readYaml(path: string): unknown {
  return parseYaml(readFileSync(path, "utf8"));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Parse a Grafana dashboard `refresh` value (e.g. "30s", "1m", "500ms") into
 * seconds. Returns null when auto-refresh is disabled (false / "" ).
 */
function refreshToSeconds(refresh: unknown): number | null {
  if (refresh === false || refresh === "" || refresh == null) return null;
  if (typeof refresh !== "string") {
    throw new Error(`unexpected refresh value: ${JSON.stringify(refresh)}`);
  }
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(refresh.trim());
  if (!match) throw new Error(`unparseable refresh value: ${refresh}`);
  const value = Number(match[1]);
  const unit = match[2];
  const perUnit: Record<string, number> = {
    ms: 1 / 1000,
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
  };
  return value * perUnit[unit];
}

/** Collect all panels including any nested inside row panels. */
function flattenPanels(panels: any[]): any[] {
  const out: any[] = [];
  for (const panel of panels) {
    out.push(panel);
    if (Array.isArray(panel?.panels)) {
      out.push(...panel.panels);
    }
  }
  return out;
}

describe("Grafana datasource provisioning (Requirement 4.1)", () => {
  it("is valid YAML with the provisioning apiVersion", () => {
    const doc = readYaml(datasourceFile) as any;
    expect(doc).toBeTypeOf("object");
    expect(doc).not.toBeNull();
    expect(doc.apiVersion).toBe(1);
    expect(Array.isArray(doc.datasources)).toBe(true);
    expect(doc.datasources.length).toBeGreaterThanOrEqual(1);
  });

  it("provisions Prometheus as the default datasource", () => {
    const doc = readYaml(datasourceFile) as any;
    const prom = doc.datasources.find((d: any) => d.type === "prometheus");
    expect(prom, "a prometheus datasource must be provisioned").toBeDefined();
    expect(prom.isDefault).toBe(true);
    // Points at a Prometheus URL (the Compose service), not empty.
    expect(typeof prom.url).toBe("string");
    expect(prom.url.length).toBeGreaterThan(0);
  });
});

describe("Grafana dashboards provider provisioning (Requirement 4.1)", () => {
  it("is valid YAML declaring a file provider for the dashboards folder", () => {
    const doc = readYaml(dashboardsProviderFile) as any;
    expect(doc.apiVersion).toBe(1);
    expect(Array.isArray(doc.providers)).toBe(true);
    const fileProvider = doc.providers.find((p: any) => p.type === "file");
    expect(fileProvider, "a file-type dashboard provider must exist").toBeDefined();
    expect(fileProvider.options?.path).toBeTypeOf("string");
    expect(fileProvider.options.path.length).toBeGreaterThan(0);
  });
});

describe.each(Object.entries(dashboardFiles))(
  "Grafana dashboard: %s (Requirements 4.1, 4.3, 4.4)",
  (name, file) => {
    it("is valid JSON with a panels array", () => {
      const dash = readJson(file) as any;
      expect(dash).toBeTypeOf("object");
      expect(dash).not.toBeNull();
      expect(typeof dash.uid).toBe("string");
      expect(Array.isArray(dash.panels)).toBe(true);
      expect(dash.panels.length).toBeGreaterThan(0);
    });

    it("refreshes at an interval <= 60 seconds (Requirement 4.3)", () => {
      const dash = readJson(file) as any;
      const seconds = refreshToSeconds(dash.refresh);
      // A dashboard with auto-refresh disabled would never satisfy the "<= 60s"
      // live-refresh requirement, so a concrete refresh value is required here.
      expect(seconds, `${name} must define an auto-refresh interval`).not.toBeNull();
      expect(seconds as number).toBeGreaterThan(0);
      expect(seconds as number).toBeLessThanOrEqual(60);
    });

    it("defines a no-data state on every panel (Requirement 4.4)", () => {
      const dash = readJson(file) as any;
      const panels = flattenPanels(dash.panels);
      // Only data-bearing panels (rows are pure layout) must carry a no-data
      // state; here every configured panel is a data panel.
      for (const panel of panels) {
        if (panel.type === "row") continue;
        const noValue = panel?.fieldConfig?.defaults?.noValue;
        expect(
          noValue,
          `panel "${panel.title ?? panel.id}" in ${name} must define a no-data state (fieldConfig.defaults.noValue)`,
        ).toBeTypeOf("string");
        expect((noValue as string).length).toBeGreaterThan(0);
      }
    });
  },
);
