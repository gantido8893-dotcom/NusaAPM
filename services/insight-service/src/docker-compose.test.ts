// Feature: personal-ai-apm-system
// Smoke / schema test for the root docker-compose.yml full-stack orchestration.
//
// This is intentionally a static, offline test: it parses docker-compose.yml
// with js-yaml and asserts the config's shape. It deliberately does NOT run
// `docker compose up` or invoke Docker at all, so the test stays free
// (Requirement 13) and deterministic — no images pulled, no ports bound.
//
// Validates:
//   Requirement 1.6  — Metrics_Store retains metrics for a configured retention
//                       period of at least 30 days (default 90 days). Asserted
//                       via the Prometheus --storage.tsdb.retention.time flag.
//   Requirement 14.2 — The Simple_View / stack is accessed without auth
//                       credentials. Asserted via Grafana anonymous access being
//                       enabled.
//   Requirement 15.1 — A single Docker Compose config starts the Metrics_Store
//                       (Prometheus), Grafana, and the Node_Exporter.
//   Requirement 15.2 — Where the Monitored_App runs in a container, the config
//                       also starts cAdvisor.
//   Requirement 15.4 — If any component fails to start, the identity of the
//                       failed component is reportable (Docker Compose's built-in
//                       per-service reporting; asserted structurally via named,
//                       restart-policied services + documentation of the signal).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { load } from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// src -> insight-service -> services -> repo root -> docker-compose.yml
const COMPOSE_PATH = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "docker-compose.yml",
);

// --- Minimal shape of the parts of docker-compose.yml we assert on ---
interface ComposeService {
  image?: string;
  build?: unknown;
  container_name?: string;
  restart?: string;
  command?: string[] | string;
  environment?: Record<string, string> | string[];
  ports?: string[];
  depends_on?: unknown;
  networks?: unknown;
  volumes?: string[];
}

interface ComposeFile {
  services?: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
  networks?: Record<string, unknown>;
}

// Requirement 1.6 floor: at least 30 days of retention.
const RETENTION_FLOOR_DAYS = 30;

// Requirements 15.1 + 15.2: the full stack the single command must bring up.
const REQUIRED_SERVICES = [
  "prometheus", // Metrics_Store (15.1)
  "grafana", // Dashboards + alerting (15.1)
  "node-exporter", // Host-level metrics (15.1)
  "cadvisor", // Per-container metrics (15.2)
  "target-app", // Monitored_App (context for 15.2/15.3)
  "insight-service", // Insight_Service JSON API
];

/**
 * Parse a Prometheus/Go duration string (e.g. "90d", "30d", "720h", "45m")
 * into whole days. Supports the units that make sense for a retention window:
 * y, w, d, h, m, s. Returns NaN for anything it cannot parse so callers can
 * assert on the failure explicitly.
 */
function durationToDays(value: string): number {
  const match = /^(\d+)(y|w|d|h|m|s)$/.exec(value.trim());
  if (!match) return Number.NaN;
  const amount = Number(match[1]);
  switch (match[2]) {
    case "y":
      return amount * 365;
    case "w":
      return amount * 7;
    case "d":
      return amount;
    case "h":
      return amount / 24;
    case "m":
      return amount / (24 * 60);
    case "s":
      return amount / (24 * 60 * 60);
    default:
      return Number.NaN;
  }
}

/**
 * Normalize a service's command (string or list form) to an array of tokens.
 */
function commandTokens(command: ComposeService["command"]): string[] {
  if (Array.isArray(command)) return command;
  if (typeof command === "string") return command.split(/\s+/);
  return [];
}

/**
 * Read a service environment (map or "KEY=VALUE" list form) into a map.
 */
function envMap(
  environment: ComposeService["environment"],
): Record<string, string> {
  if (!environment) return {};
  if (Array.isArray(environment)) {
    const map: Record<string, string> = {};
    for (const entry of environment) {
      const eq = entry.indexOf("=");
      if (eq === -1) {
        map[entry] = "";
      } else {
        map[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
    }
    return map;
  }
  return environment;
}

function loadCompose(): ComposeFile {
  const raw = readFileSync(COMPOSE_PATH, "utf8");
  return load(raw) as ComposeFile;
}

/** Pull the --storage.tsdb.retention.time value from a token list. */
function retentionValueFromTokens(tokens: string[]): string | undefined {
  const FLAG = "--storage.tsdb.retention.time";
  for (const token of tokens) {
    if (token.startsWith(`${FLAG}=`)) {
      return token.slice(`${FLAG}=`.length);
    }
  }
  // Also support the space-separated form: ["--storage.tsdb.retention.time", "90d"]
  const idx = tokens.indexOf(FLAG);
  if (idx !== -1 && idx + 1 < tokens.length) {
    return tokens[idx + 1];
  }
  return undefined;
}

describe("docker-compose.yml full-stack smoke test", () => {
  it("is present and parses as valid YAML into an object", () => {
    let parsed: unknown;
    expect(() => {
      parsed = loadCompose();
    }).not.toThrow();
    expect(parsed).toBeTypeOf("object");
    expect(parsed).not.toBeNull();
  });

  it("defines a services map", () => {
    const compose = loadCompose();
    expect(compose.services).toBeTypeOf("object");
    expect(compose.services).not.toBeNull();
  });

  it("defines all required services for the single-command stack (Requirements 15.1, 15.2)", () => {
    const compose = loadCompose();
    const serviceNames = Object.keys(compose.services ?? {});
    for (const expected of REQUIRED_SERVICES) {
      expect(serviceNames, `missing service: ${expected}`).toContain(expected);
    }
  });

  it("each required service is startable — has an image or a build context (Requirement 15.1)", () => {
    const compose = loadCompose();
    for (const name of REQUIRED_SERVICES) {
      const service = compose.services?.[name];
      expect(service, `service ${name} is undefined`).toBeDefined();
      const hasImage = typeof service?.image === "string" && service.image.length > 0;
      const hasBuild = service?.build !== undefined;
      expect(
        hasImage || hasBuild,
        `service ${name} must define an image or build context`,
      ).toBe(true);
    }
  });

  it("sets the Prometheus retention flag to at least 30 days (Requirement 1.6)", () => {
    const compose = loadCompose();
    const prometheus = compose.services?.prometheus;
    expect(prometheus, "prometheus service must be defined").toBeDefined();

    const tokens = commandTokens(prometheus?.command);
    const retention = retentionValueFromTokens(tokens);
    expect(
      retention,
      "prometheus command must set --storage.tsdb.retention.time",
    ).toBeTypeOf("string");

    const days = durationToDays(retention as string);
    expect(
      Number.isNaN(days),
      `unparseable retention duration: ${retention}`,
    ).toBe(false);
    expect(days).toBeGreaterThanOrEqual(RETENTION_FLOOR_DAYS);
  });

  it("enables Grafana anonymous access for single-user, no-login access (Requirement 14.2)", () => {
    const compose = loadCompose();
    const grafana = compose.services?.grafana;
    expect(grafana, "grafana service must be defined").toBeDefined();

    const env = envMap(grafana?.environment);
    const anonEnabled = String(env.GF_AUTH_ANONYMOUS_ENABLED).toLowerCase();
    expect(
      anonEnabled,
      "GF_AUTH_ANONYMOUS_ENABLED must be true so the Simple_View needs no credentials",
    ).toBe("true");
  });

  it("provisions Grafana from the repo provisioning directory so dashboards/datasources load without login (Requirement 14.2)", () => {
    const compose = loadCompose();
    const grafana = compose.services?.grafana;
    const volumes = grafana?.volumes ?? [];
    const mountsProvisioning = volumes.some((v) =>
      v.includes("./grafana/provisioning"),
    );
    expect(
      mountsProvisioning,
      "grafana must mount ./grafana/provisioning",
    ).toBe(true);
  });

  it("gives every service a restart policy so a failed component is retried and its state is observable (Requirement 15.4)", () => {
    const compose = loadCompose();
    const services = compose.services ?? {};
    for (const [name, service] of Object.entries(services)) {
      expect(
        service.restart,
        `service ${name} must declare a restart policy`,
      ).toBeTypeOf("string");
      expect((service.restart as string).length).toBeGreaterThan(0);
    }
  });

  it("names every service so Docker Compose can report the identity of a failed component (Requirement 15.4)", () => {
    // Docker Compose reports the failing service by its compose key (and here
    // also by an explicit container_name), which is the mechanism the acceptance
    // criterion relies on. We assert both the service key and a stable
    // container_name exist for each service.
    const compose = loadCompose();
    const services = compose.services ?? {};
    expect(Object.keys(services).length).toBeGreaterThan(0);
    for (const [name, service] of Object.entries(services)) {
      expect(name.length, "service key must be a non-empty identifier").toBeGreaterThan(0);
      expect(
        service.container_name,
        `service ${name} should set a stable container_name for identification`,
      ).toBeTypeOf("string");
    }
  });

  it("target-app and cAdvisor are both containerized, satisfying the container clause (Requirement 15.2)", () => {
    const compose = loadCompose();
    const targetApp = compose.services?.["target-app"];
    const cadvisor = compose.services?.cadvisor;
    // The Monitored_App runs in a container (has a build context)...
    expect(targetApp?.build, "target-app must run in a container").toBeDefined();
    // ...therefore cAdvisor must be present to scrape per-container metrics.
    expect(cadvisor, "cadvisor must be started alongside a containerized app").toBeDefined();
  });
});
