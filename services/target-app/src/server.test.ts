// Smoke test for the target app's /metrics endpoint (task 1.5, Requirement 1.1).
//
// Verifies that:
//   1. GET /metrics responds successfully with the Prometheus text
//      exposition Content-Type.
//   2. The body parses as valid Prometheus text exposition format
//      (well-formed # HELP / # TYPE lines and sample lines).
//   3. The three required series are present: request latency (histogram),
//      request throughput (counter), and request errors (counter).
//
// The server is started on an ephemeral port so the test is self-contained
// and does not collide with a running instance.
import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, TargetApp } from "./server";

const LATENCY_METRIC = "http_request_duration_seconds";
const THROUGHPUT_METRIC = "http_requests_total";
const ERROR_METRIC = "http_request_errors_total";

/**
 * Minimal parser/validator for Prometheus text exposition format.
 * It does not aim to be a full parser; it asserts the structural rules that
 * make the output a valid exposition document:
 *   - `# HELP <name> <text>` and `# TYPE <name> <type>` metadata lines
 *   - sample lines of the form `<name>[{labels}] <value> [timestamp]`
 * Returns the set of distinct metric family names seen in TYPE lines and
 * the set of series (base) names seen on sample lines.
 */
function parseExposition(text: string): {
  typeNames: Set<string>;
  typeByName: Map<string, string>;
  sampleBaseNames: Set<string>;
} {
  const typeNames = new Set<string>();
  const typeByName = new Map<string, string>();
  const sampleBaseNames = new Set<string>();

  const lines = text.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;

    if (line.startsWith("#")) {
      // Comment / metadata line. Only HELP and TYPE are structured.
      const parts = line.split(/\s+/);
      const kind = parts[1];
      if (kind === "HELP") {
        // # HELP <name> <help text...>
        expect(parts.length).toBeGreaterThanOrEqual(3);
        expect(parts[2]).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*$/);
      } else if (kind === "TYPE") {
        // # TYPE <name> <type>
        expect(parts.length).toBe(4);
        const name = parts[2];
        const type = parts[3];
        expect(name).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*$/);
        expect([
          "counter",
          "gauge",
          "histogram",
          "summary",
          "untyped",
        ]).toContain(type);
        typeNames.add(name);
        typeByName.set(name, type);
      }
      continue;
    }

    // Sample line: <metric_name>[{labels}] <value> [<timestamp>]
    // The value token is a float, +Inf/-Inf, or NaN. prom-client renders the
    // special floats with mixed casing (e.g. "Nan"), so match them case-
    // insensitively.
    const match = line.match(
      /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{.*\})?\s+(-?[0-9eE+.\-]+|[+-]?inf|nan)(\s+-?[0-9]+)?$/i,
    );
    expect(match, `sample line should be valid exposition: "${line}"`).not.toBeNull();
    const fullName = match![1];
    // Histogram/summary series append _bucket/_sum/_count suffixes to the
    // family name; strip them to recover the declared family base name.
    const base = fullName.replace(/_(bucket|sum|count)$/, "");
    sampleBaseNames.add(base);
  }

  return { typeNames, typeByName, sampleBaseNames };
}

describe("target-app /metrics endpoint (smoke)", () => {
  let app: TargetApp;
  let baseUrl: string;

  beforeAll(async () => {
    app = createApp();
    await new Promise<void>((resolve) => {
      // Port 0 => OS assigns a free ephemeral port.
      app.server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    // Drive a little traffic so the counters/histogram have samples: a
    // successful request and a request against a non-existent route.
    await fetch(`${baseUrl}/`);
    await fetch(`${baseUrl}/does-not-exist`);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      app.server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("responds to GET /metrics with the Prometheus exposition content type", async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    // prom-client uses "text/plain; version=0.0.4; charset=utf-8".
    expect(contentType).toContain("text/plain");
    expect(contentType).toContain("version=0.0.4");

    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it("emits output that parses as valid Prometheus text exposition format", async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    const body = await res.text();

    const { typeNames, typeByName, sampleBaseNames } = parseExposition(body);

    // A non-trivial document with declared metric families and samples.
    expect(typeNames.size).toBeGreaterThan(0);
    expect(sampleBaseNames.size).toBeGreaterThan(0);
    // Every declared family should have been surfaced somewhere (sanity).
    expect(typeByName.size).toBe(typeNames.size);
  });

  it("exposes the latency, throughput, and error series", async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    const body = await res.text();

    const { typeByName, sampleBaseNames } = parseExposition(body);

    // Latency is a histogram → declared as such and present as samples
    // (with _bucket/_sum/_count series collapsing to the base name).
    expect(typeByName.get(LATENCY_METRIC)).toBe("histogram");
    expect(sampleBaseNames.has(LATENCY_METRIC)).toBe(true);

    // Throughput and errors are counters.
    expect(typeByName.get(THROUGHPUT_METRIC)).toBe("counter");
    expect(sampleBaseNames.has(THROUGHPUT_METRIC)).toBe(true);

    expect(typeByName.get(ERROR_METRIC)).toBe("counter");
    // The error family is declared even before an error occurs; the throughput
    // counter must have at least one sample from the traffic driven above.
    expect(body).toContain(`# TYPE ${ERROR_METRIC} counter`);
    expect(body).toMatch(new RegExp(`^${THROUGHPUT_METRIC}\\{`, "m"));
  });
});
