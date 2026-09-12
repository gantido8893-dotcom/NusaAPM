// Feature: personal-ai-apm-system
// Schema / snapshot test for the root prometheus/prometheus.yml scrape config.
//
// Validates:
//   Requirement 1.2 — Monitored_App scraped at a configured interval between 5 and 60 seconds (default 15s).
//   Requirement 1.4 — Node Exporter scraped at the same configured interval.
//   Requirement 1.5 — cAdvisor scraped at the same configured interval.
//
// The test asserts the file is valid YAML, defines the three expected scrape
// jobs (target-app, node-exporter, cadvisor), and that the scrape_interval and
// scrape_timeout fall within their allowed ranges (5-60s and 1-10s).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { load } from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// src -> insight-service -> services -> repo root -> prometheus/prometheus.yml
const PROMETHEUS_YML_PATH = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "prometheus",
  "prometheus.yml",
);

// --- Minimal shape of the parts of prometheus.yml we assert on ---
interface PrometheusGlobal {
  scrape_interval?: string;
  scrape_timeout?: string;
  evaluation_interval?: string;
}

interface ScrapeConfig {
  job_name: string;
  metrics_path?: string;
  scrape_interval?: string;
  scrape_timeout?: string;
}

interface PrometheusConfig {
  global?: PrometheusGlobal;
  scrape_configs?: ScrapeConfig[];
}

const ALLOWED_INTERVAL_MIN_S = 5;
const ALLOWED_INTERVAL_MAX_S = 60;
const ALLOWED_TIMEOUT_MIN_S = 1;
const ALLOWED_TIMEOUT_MAX_S = 10;

const EXPECTED_JOBS = ["target-app", "node-exporter", "cadvisor"];

/**
 * Parse a Prometheus duration string (e.g. "15s", "1m", "500ms") into seconds.
 * Supports the units Prometheus accepts for scrape durations: ms, s, m, h.
 * Returns NaN for anything it cannot parse so callers can assert on it.
 */
function durationToSeconds(value: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value.trim());
  if (!match) return Number.NaN;
  const amount = Number(match[1]);
  switch (match[2]) {
    case "ms":
      return amount / 1000;
    case "s":
      return amount;
    case "m":
      return amount * 60;
    case "h":
      return amount * 3600;
    default:
      return Number.NaN;
  }
}

function loadConfig(): PrometheusConfig {
  const raw = readFileSync(PROMETHEUS_YML_PATH, "utf8");
  return load(raw) as PrometheusConfig;
}

describe("prometheus.yml scrape configuration", () => {
  it("is present and parses as valid YAML into an object", () => {
    let parsed: unknown;
    expect(() => {
      parsed = loadConfig();
    }).not.toThrow();
    expect(parsed).toBeTypeOf("object");
    expect(parsed).not.toBeNull();
  });

  it("defines the three expected scrape jobs (Requirements 1.2, 1.4, 1.5)", () => {
    const config = loadConfig();
    expect(Array.isArray(config.scrape_configs)).toBe(true);

    const jobNames = (config.scrape_configs ?? []).map((c) => c.job_name);
    for (const expected of EXPECTED_JOBS) {
      expect(jobNames).toContain(expected);
    }
  });

  it("sets a global scrape_interval within the allowed 5-60s range (Requirement 1.2)", () => {
    const config = loadConfig();
    const interval = config.global?.scrape_interval;
    expect(interval, "global.scrape_interval must be defined").toBeTypeOf(
      "string",
    );

    const seconds = durationToSeconds(interval as string);
    expect(Number.isNaN(seconds), `unparseable interval: ${interval}`).toBe(
      false,
    );
    expect(seconds).toBeGreaterThanOrEqual(ALLOWED_INTERVAL_MIN_S);
    expect(seconds).toBeLessThanOrEqual(ALLOWED_INTERVAL_MAX_S);
  });

  it("sets a global scrape_timeout within the allowed 1-10s range and <= interval (Requirement 1.2/1.3)", () => {
    const config = loadConfig();
    const timeout = config.global?.scrape_timeout;
    expect(timeout, "global.scrape_timeout must be defined").toBeTypeOf(
      "string",
    );

    const timeoutSeconds = durationToSeconds(timeout as string);
    expect(
      Number.isNaN(timeoutSeconds),
      `unparseable timeout: ${timeout}`,
    ).toBe(false);
    expect(timeoutSeconds).toBeGreaterThanOrEqual(ALLOWED_TIMEOUT_MIN_S);
    expect(timeoutSeconds).toBeLessThanOrEqual(ALLOWED_TIMEOUT_MAX_S);

    // Prometheus requires scrape_timeout <= scrape_interval.
    const intervalSeconds = durationToSeconds(
      config.global?.scrape_interval as string,
    );
    expect(timeoutSeconds).toBeLessThanOrEqual(intervalSeconds);
  });

  it("keeps every per-job override within the allowed ranges when present (Requirements 1.2, 1.4, 1.5)", () => {
    const config = loadConfig();

    for (const job of config.scrape_configs ?? []) {
      if (job.scrape_interval !== undefined) {
        const seconds = durationToSeconds(job.scrape_interval);
        expect(
          Number.isNaN(seconds),
          `job ${job.job_name} has unparseable interval`,
        ).toBe(false);
        expect(seconds).toBeGreaterThanOrEqual(ALLOWED_INTERVAL_MIN_S);
        expect(seconds).toBeLessThanOrEqual(ALLOWED_INTERVAL_MAX_S);
      }
      if (job.scrape_timeout !== undefined) {
        const seconds = durationToSeconds(job.scrape_timeout);
        expect(
          Number.isNaN(seconds),
          `job ${job.job_name} has unparseable timeout`,
        ).toBe(false);
        expect(seconds).toBeGreaterThanOrEqual(ALLOWED_TIMEOUT_MIN_S);
        expect(seconds).toBeLessThanOrEqual(ALLOWED_TIMEOUT_MAX_S);
      }
    }
  });
});
