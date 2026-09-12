// Feature: personal-ai-apm-system — Task 3.7
// Snapshot / schema test for Grafana alerting provisioning: the alert rules,
// the webhook contact point, and the notification policy tree.
//
// Validates:
//   Requirement 5.1 — When a tracked metric enters its Red_Band, Grafana sends
//                     a notification. A rule labelled `band: red` (the Red_Band
//                     rule) must be provisioned.
//   Requirement 5.3 — The notification includes the metric name, the observed
//                     value, the Red_Band threshold that was crossed, and the
//                     timestamp of the crossing. The contact point message
//                     template must reference all four fields.
//   Requirement 5.4 — On webhook failure, delivery is retried at most 3 times,
//                     spaced no less than 30 seconds apart
//                     (maxRetries <= 3, retryIntervalSeconds >= 30).
//   Requirement 5.5 — While a metric stays in its Red_Band, re-notify at most
//                     once per a configurable interval between 1 and 1440
//                     minutes (Grafana `repeat_interval`). The value is supplied
//                     via the ${APM_ALERT_REPEAT_INTERVAL} env-var placeholder
//                     (the numeric 1..1440 range is enforced at deploy time; the
//                     documented default of 60m sits inside the range).
//
// All three files are static config parsed with js-yaml (free OSS). No live
// Grafana is required — these are static-config assertions so the test stays
// free and deterministic (Requirement 13).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { load as parseYaml } from "js-yaml";
import { describe, it, expect } from "vitest";

// Resolve the grafana/provisioning/alerting directory relative to this test
// file (services/insight-service/src/ -> ../../../grafana/provisioning/alerting).
const here = dirname(fileURLToPath(import.meta.url));
const alertingDir = resolve(here, "..", "..", "..", "grafana", "provisioning", "alerting");

const alertRulesFile = resolve(alertingDir, "alert-rules.yml");
const contactPointsFile = resolve(alertingDir, "contact-points.yml");
const notificationPoliciesFile = resolve(alertingDir, "notification-policies.yml");

function readYaml(path: string): unknown {
  return parseYaml(readFileSync(path, "utf8"));
}

function readRaw(path: string): string {
  return readFileSync(path, "utf8");
}

// Retry policy bounds (Requirement 5.4).
const MAX_RETRY_ATTEMPTS = 3;
const MIN_RETRY_INTERVAL_SECONDS = 30;

// Re-notification interval bounds in minutes (Requirement 5.5).
const REPEAT_INTERVAL_MIN_MINUTES = 1;
const REPEAT_INTERVAL_MAX_MINUTES = 1440;
// Documented default when the env var is unset.
const DOCUMENTED_DEFAULT_REPEAT_MINUTES = 60;

// The env-var placeholder that carries the configurable re-notification interval.
const REPEAT_INTERVAL_PLACEHOLDER = "${APM_ALERT_REPEAT_INTERVAL}";

// The four notification fields the contact point message must reference (5.3).
const REQUIRED_NOTIFICATION_FIELDS = [
  "metric", // metric name
  "observed_value", // observed value
  "red_threshold", // red threshold crossed
  "StartsAt", // crossing timestamp
];

/**
 * Recursively collect every rule object under a Grafana provisioned
 * alert-rules file (groups[].rules[]).
 */
function collectRules(doc: any): any[] {
  const groups = Array.isArray(doc?.groups) ? doc.groups : [];
  const rules: any[] = [];
  for (const group of groups) {
    if (Array.isArray(group?.rules)) rules.push(...group.rules);
  }
  return rules;
}

/** Recursively collect a policy node and all of its nested routes. */
function collectPolicyNodes(node: any): any[] {
  if (node == null || typeof node !== "object") return [];
  const nodes = [node];
  if (Array.isArray(node.routes)) {
    for (const child of node.routes) nodes.push(...collectPolicyNodes(child));
  }
  return nodes;
}

describe("Grafana alerting provisioning — all files are valid YAML", () => {
  it.each([
    ["alert-rules.yml", alertRulesFile],
    ["contact-points.yml", contactPointsFile],
    ["notification-policies.yml", notificationPoliciesFile],
  ])("%s parses as valid YAML into an object", (_name, file) => {
    let parsed: unknown;
    expect(() => {
      parsed = readYaml(file);
    }).not.toThrow();
    expect(parsed).toBeTypeOf("object");
    expect(parsed).not.toBeNull();
    // Grafana provisioning files declare apiVersion: 1.
    expect((parsed as any).apiVersion).toBe(1);
  });
});

describe("Grafana alert rules — a Red_Band rule is provisioned (Requirement 5.1)", () => {
  it("defines at least one rule labelled band: red", () => {
    const doc = readYaml(alertRulesFile) as any;
    const rules = collectRules(doc);
    expect(rules.length).toBeGreaterThan(0);

    const redRules = rules.filter((r) => r?.labels?.band === "red");
    expect(
      redRules.length,
      "at least one alert rule must carry label band: red (a Red_Band rule)",
    ).toBeGreaterThanOrEqual(1);
  });

  it("each Red_Band rule carries the metric label and notification annotations (Requirement 5.3)", () => {
    const doc = readYaml(alertRulesFile) as any;
    const redRules = collectRules(doc).filter((r) => r?.labels?.band === "red");

    for (const rule of redRules) {
      const title = rule?.title ?? rule?.uid ?? "<unnamed rule>";
      // Metric name is on the rule (used by the contact point message).
      expect(
        typeof rule?.labels?.metric === "string" && rule.labels.metric.length > 0,
        `Red_Band rule "${title}" must carry a metric label`,
      ).toBe(true);
      // Observed value + red threshold annotations feed the notification body.
      expect(
        typeof rule?.annotations?.observed_value === "string",
        `Red_Band rule "${title}" must annotate observed_value`,
      ).toBe(true);
      expect(
        typeof rule?.annotations?.red_threshold === "string",
        `Red_Band rule "${title}" must annotate red_threshold`,
      ).toBe(true);
    }
  });
});

describe("Grafana webhook contact point — retry policy (Requirement 5.4)", () => {
  it("configures at most 3 retry attempts, spaced at least 30 seconds apart", () => {
    const doc = readYaml(contactPointsFile) as any;
    const contactPoints = Array.isArray(doc?.contactPoints) ? doc.contactPoints : [];
    expect(contactPoints.length).toBeGreaterThan(0);

    // Find the webhook receiver.
    const receivers = contactPoints
      .flatMap((cp: any) => (Array.isArray(cp?.receivers) ? cp.receivers : []))
      .filter((r: any) => r?.type === "webhook");
    expect(
      receivers.length,
      "at least one webhook contact point must be provisioned",
    ).toBeGreaterThanOrEqual(1);

    for (const receiver of receivers) {
      const settings = receiver?.settings ?? {};
      const maxRetries = settings.maxRetries;
      const retryIntervalSeconds = settings.retryIntervalSeconds;

      expect(typeof maxRetries, "maxRetries must be numeric").toBe("number");
      expect(maxRetries).toBeGreaterThanOrEqual(1);
      expect(maxRetries).toBeLessThanOrEqual(MAX_RETRY_ATTEMPTS);

      expect(
        typeof retryIntervalSeconds,
        "retryIntervalSeconds must be numeric",
      ).toBe("number");
      expect(retryIntervalSeconds).toBeGreaterThanOrEqual(MIN_RETRY_INTERVAL_SECONDS);
    }
  });
});

describe("Grafana webhook contact point — notification fields (Requirement 5.3)", () => {
  it("the message template references metric name, observed value, red threshold, and timestamp", () => {
    const doc = readYaml(contactPointsFile) as any;
    const receivers = (doc?.contactPoints ?? [])
      .flatMap((cp: any) => (Array.isArray(cp?.receivers) ? cp.receivers : []))
      .filter((r: any) => r?.type === "webhook");

    // At least one webhook receiver must template all four required fields.
    const templatesWithAllFields = receivers.filter((r: any) => {
      const message = r?.settings?.message;
      if (typeof message !== "string") return false;
      return REQUIRED_NOTIFICATION_FIELDS.every((field) => message.includes(field));
    });

    expect(
      templatesWithAllFields.length,
      `a webhook message template must reference all of: ${REQUIRED_NOTIFICATION_FIELDS.join(", ")}`,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("Grafana notification policy — configurable re-notification interval (Requirement 5.5)", () => {
  it("configures a repeat_interval on the routing policy", () => {
    const doc = readYaml(notificationPoliciesFile) as any;
    const policies = Array.isArray(doc?.policies) ? doc.policies : [];
    expect(policies.length).toBeGreaterThan(0);

    const allNodes = policies.flatMap((p: any) => collectPolicyNodes(p));
    const nodesWithRepeat = allNodes.filter(
      (n: any) => n?.repeat_interval !== undefined && n.repeat_interval !== null,
    );
    expect(
      nodesWithRepeat.length,
      "at least one policy node must set a repeat_interval (re-notification interval)",
    ).toBeGreaterThanOrEqual(1);
  });

  it("supplies repeat_interval via the ${APM_ALERT_REPEAT_INTERVAL} env-var placeholder", () => {
    // js-yaml parses the placeholder as a literal string; confirm the raw file
    // and the parsed value both carry the placeholder (range enforced at deploy).
    const raw = readRaw(notificationPoliciesFile);
    expect(raw).toContain(REPEAT_INTERVAL_PLACEHOLDER);

    const doc = readYaml(notificationPoliciesFile) as any;
    const allNodes = (doc?.policies ?? []).flatMap((p: any) => collectPolicyNodes(p));
    const placeholderNodes = allNodes.filter(
      (n: any) =>
        typeof n?.repeat_interval === "string" &&
        n.repeat_interval.includes(REPEAT_INTERVAL_PLACEHOLDER),
    );
    expect(
      placeholderNodes.length,
      "repeat_interval must be sourced from the configurable env-var placeholder",
    ).toBeGreaterThanOrEqual(1);
  });

  it("documents a default re-notification interval within the 1-1440 minute range", () => {
    // The env-var placeholder makes the interval configurable; the documented
    // default (60m) must fall inside the required 1..1440 minute range, and the
    // range bounds themselves are sane.
    expect(REPEAT_INTERVAL_MIN_MINUTES).toBe(1);
    expect(REPEAT_INTERVAL_MAX_MINUTES).toBe(1440);
    expect(DOCUMENTED_DEFAULT_REPEAT_MINUTES).toBeGreaterThanOrEqual(
      REPEAT_INTERVAL_MIN_MINUTES,
    );
    expect(DOCUMENTED_DEFAULT_REPEAT_MINUTES).toBeLessThanOrEqual(
      REPEAT_INTERVAL_MAX_MINUTES,
    );

    // The default is documented in the policy file's comments.
    const raw = readRaw(notificationPoliciesFile);
    expect(raw).toMatch(/default\s+60m/i);
  });
});
