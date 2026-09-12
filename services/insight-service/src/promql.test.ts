// Feature: personal-ai-apm-system
// Unit tests for promql.ts — the Prometheus HTTP API client.
//
// The whole point of this module is to distinguish two outcomes that look
// similar but must be handled very differently downstream:
//   - a *successful* query that matched no series  -> returns []  ("no data")
//   - a *transport* failure (unreachable / timeout / non-OK / status:"error" /
//     unparseable body)                             -> throws PromTransportError
//                                                        ("unreachable / stale")
//
// These tests mock the global `fetch` so they never touch a real Prometheus,
// which keeps them free (Requirement 13) and deterministic. They cover:
//   - vector extraction    (one Sample per series)
//   - matrix extraction     (flattened + chronologically sorted)
//   - empty result set      -> [] (Requirements 2.7, 4.4, 9.4 — the "no data" case)
//   - transport failures    -> PromTransportError (the "unreachable" case)
//   - timeout / abort       -> PromTransportError
//   - targetsUp()           -> Record<instance, boolean>
//
// Requirements: 2.7, 4.4, 9.4

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TIMEOUT_MS,
  HttpPromClient,
  PromTransportError,
  buildMemoryByVolumeQuery,
  buildP95LatencyByLoadQuery,
  createPromClient,
} from "./promql.js";

const BASE_URL = "http://prometheus.test:9090";

// ---------------------------------------------------------------------------
// fetch mocking helpers
// ---------------------------------------------------------------------------

/** Build a minimal `Response`-like object that satisfies what getJson uses. */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  const ok = init?.ok ?? true;
  const status = init?.status ?? (ok ? 200 : 500);
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Build a Response whose json() rejects, to simulate an unparseable body. */
function unparseableResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  } as unknown as Response;
}

/** Install a fetch mock that resolves to the given response for every call. */
function stubFetchResolve(response: Response) {
  const mock = vi.fn(async (_url?: unknown, _init?: unknown) => response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** Install a fetch mock that rejects with the given error for every call. */
function stubFetchReject(err: unknown) {
  const mock = vi.fn(async (_url?: unknown, _init?: unknown): Promise<Response> => {
    throw err;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// instant() — vector extraction and the "no data" case
// ---------------------------------------------------------------------------

describe("HttpPromClient.instant", () => {
  it("extracts one Sample per series from a vector result", async () => {
    const body = {
      status: "success",
      data: {
        resultType: "vector",
        result: [
          { metric: { load_level: "1" }, value: [1_700_000_000, "0.12"] },
          { metric: { load_level: "2" }, value: [1_700_000_010, "0.34"] },
        ],
      },
    };
    stubFetchResolve(jsonResponse(body));

    const client = new HttpPromClient({ baseUrl: BASE_URL });
    const samples = await client.instant("up");

    expect(samples).toEqual([
      { tMs: 1_700_000_000_000, value: 0.12 },
      { tMs: 1_700_000_010_000, value: 0.34 },
    ]);
  });

  it("issues the query against /api/v1/query with the query param", async () => {
    const mock = stubFetchResolve(
      jsonResponse({ status: "success", data: { resultType: "vector", result: [] } }),
    );

    const client = new HttpPromClient({ baseUrl: BASE_URL });
    await client.instant('rate(http_requests_total[5m])');

    expect(mock).toHaveBeenCalledTimes(1);
    const url = mock.mock.calls[0][0] as string;
    expect(url).toContain(`${BASE_URL}/api/v1/query?`);
    expect(url).toContain("query=");
    // The PromQL is URL-encoded in the query string.
    expect(decodeURIComponent(url)).toContain("rate(http_requests_total[5m])");
  });

  it("returns [] for a successful query with an empty result set (no-data, NOT an error)", async () => {
    stubFetchResolve(
      jsonResponse({ status: "success", data: { resultType: "vector", result: [] } }),
    );

    const client = new HttpPromClient({ baseUrl: BASE_URL });
    await expect(client.instant("up")).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// range() — matrix flattening + chronological sort
// ---------------------------------------------------------------------------

describe("HttpPromClient.range", () => {
  it("flattens matrix series and sorts samples chronologically", async () => {
    // Two series with interleaved, out-of-order timestamps to prove sorting
    // happens across the flattened set, not just within one series.
    const body = {
      status: "success",
      data: {
        resultType: "matrix",
        result: [
          {
            metric: { instance: "a" },
            values: [
              [1_700_000_030, "3"],
              [1_700_000_010, "1"],
            ],
          },
          {
            metric: { instance: "b" },
            values: [
              [1_700_000_020, "2"],
              [1_700_000_040, "4"],
            ],
          },
        ],
      },
    };
    stubFetchResolve(jsonResponse(body));

    const client = new HttpPromClient({ baseUrl: BASE_URL });
    const samples = await client.range({
      query: "process_resident_memory_bytes",
      startMs: 1_700_000_000_000,
      endMs: 1_700_000_050_000,
      stepSeconds: 10,
    });

    expect(samples).toEqual([
      { tMs: 1_700_000_010_000, value: 1 },
      { tMs: 1_700_000_020_000, value: 2 },
      { tMs: 1_700_000_030_000, value: 3 },
      { tMs: 1_700_000_040_000, value: 4 },
    ]);
    // Confirm ascending order explicitly.
    const times = samples.map((s) => s.tMs);
    expect(times).toEqual([...times].sort((x, y) => x - y));
  });

  it("targets /api/v1/query_range with start/end (seconds) and step params", async () => {
    const mock = stubFetchResolve(
      jsonResponse({ status: "success", data: { resultType: "matrix", result: [] } }),
    );

    const client = new HttpPromClient({ baseUrl: BASE_URL });
    await client.range({
      query: "up",
      startMs: 1_700_000_000_000,
      endMs: 1_700_000_060_000,
      stepSeconds: 15,
    });

    const url = mock.mock.calls[0][0] as string;
    expect(url).toContain(`${BASE_URL}/api/v1/query_range?`);
    expect(url).toContain("start=1700000000");
    expect(url).toContain("end=1700000060");
    expect(url).toContain("step=15");
  });

  it("returns [] for a successful range query with no matching series (no-data)", async () => {
    stubFetchResolve(
      jsonResponse({ status: "success", data: { resultType: "matrix", result: [] } }),
    );

    const client = new HttpPromClient({ baseUrl: BASE_URL });
    await expect(
      client.range({
        query: "up",
        startMs: 0,
        endMs: 1000,
        stepSeconds: 1,
      }),
    ).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Transport failures — the "unreachable" case (Req 2.7, 4.4, 9.4)
// ---------------------------------------------------------------------------

describe("HttpPromClient transport failures throw PromTransportError", () => {
  it("throws when fetch rejects (network / unreachable)", async () => {
    stubFetchReject(new TypeError("fetch failed"));

    const client = new HttpPromClient({ baseUrl: BASE_URL });
    await expect(client.instant("up")).rejects.toBeInstanceOf(PromTransportError);
  });

  it("throws on a non-OK HTTP status", async () => {
    stubFetchResolve(jsonResponse({ status: "error" }, { ok: false, status: 503 }));

    const client = new HttpPromClient({ baseUrl: BASE_URL });
    await expect(client.instant("up")).rejects.toMatchObject({
      name: "PromTransportError",
    });
  });

  it('throws when the body reports status:"error" even on a 200 response', async () => {
    stubFetchResolve(
      jsonResponse({
        status: "error",
        errorType: "bad_data",
        error: "parse error: unexpected end of input",
      }),
    );

    const client = new HttpPromClient({ baseUrl: BASE_URL });
    await expect(client.instant("up(")).rejects.toBeInstanceOf(PromTransportError);
  });

  it("throws when the response body is unparseable JSON", async () => {
    stubFetchResolve(unparseableResponse());

    const client = new HttpPromClient({ baseUrl: BASE_URL });
    await expect(client.instant("up")).rejects.toBeInstanceOf(PromTransportError);
  });

  it("preserves the original error as the cause on a network failure", async () => {
    const original = new TypeError("connection refused");
    stubFetchReject(original);

    const client = new HttpPromClient({ baseUrl: BASE_URL });
    try {
      await client.instant("up");
      expect.unreachable("instant() should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PromTransportError);
      expect((err as PromTransportError).cause).toBe(original);
    }
  });
});

// ---------------------------------------------------------------------------
// Timeout / abort behavior
// ---------------------------------------------------------------------------

describe("HttpPromClient timeout / abort", () => {
  it("throws PromTransportError when fetch rejects with an AbortError", async () => {
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    stubFetchReject(abortErr);

    const client = new HttpPromClient({ baseUrl: BASE_URL, timeoutMs: 50 });
    await expect(client.instant("up")).rejects.toBeInstanceOf(PromTransportError);
  });

  it("surfaces a timeout message mentioning the configured timeout", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    stubFetchReject(abortErr);

    const client = new HttpPromClient({ baseUrl: BASE_URL, timeoutMs: 1234 });
    await expect(client.instant("up")).rejects.toThrow(/1234ms/);
  });

  it("aborts the request once the timeout elapses (fake timers)", async () => {
    vi.useFakeTimers();

    // fetch resolves only when its own signal aborts, mirroring real fetch.
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpPromClient({ baseUrl: BASE_URL, timeoutMs: 2000 });
    const pending = client.instant("up");
    // Attach a rejection handler before advancing timers so the rejection is observed.
    const assertion = expect(pending).rejects.toBeInstanceOf(PromTransportError);

    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
  });

  it("uses DEFAULT_TIMEOUT_MS when no timeout is configured", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// targetsUp()
// ---------------------------------------------------------------------------

describe("HttpPromClient.targetsUp", () => {
  it("maps activeTargets health to a Record<instance, boolean>", async () => {
    const body = {
      status: "success",
      data: {
        activeTargets: [
          { labels: { instance: "target-app:3000" }, health: "up" },
          { labels: { instance: "node-exporter:9100" }, health: "down" },
          { labels: { instance: "cadvisor:8080" }, health: "unknown" },
        ],
      },
    };
    stubFetchResolve(jsonResponse(body));

    const client = new HttpPromClient({ baseUrl: BASE_URL });
    const up = await client.targetsUp();

    expect(up).toEqual({
      "target-app:3000": true,
      "node-exporter:9100": false,
      "cadvisor:8080": false,
    });
  });

  it("falls back to job then scrapeUrl when instance label is absent", async () => {
    const body = {
      status: "success",
      data: {
        activeTargets: [
          { labels: { job: "target-app" }, health: "up" },
          { scrapeUrl: "http://cadvisor:8080/metrics", health: "down" },
        ],
      },
    };
    stubFetchResolve(jsonResponse(body));

    const client = new HttpPromClient({ baseUrl: BASE_URL });
    const up = await client.targetsUp();

    expect(up).toEqual({
      "target-app": true,
      "http://cadvisor:8080/metrics": false,
    });
  });

  it("returns {} when there are no active targets (no-data, not an error)", async () => {
    stubFetchResolve(jsonResponse({ status: "success", data: { activeTargets: [] } }));

    const client = new HttpPromClient({ baseUrl: BASE_URL });
    await expect(client.targetsUp()).resolves.toEqual({});
  });

  it("throws PromTransportError when the targets query reports an error status", async () => {
    stubFetchResolve(jsonResponse({ status: "error", error: "server error" }));

    const client = new HttpPromClient({ baseUrl: BASE_URL });
    await expect(client.targetsUp()).rejects.toBeInstanceOf(PromTransportError);
  });

  it("queries /api/v1/targets", async () => {
    const mock = stubFetchResolve(
      jsonResponse({ status: "success", data: { activeTargets: [] } }),
    );

    const client = new HttpPromClient({ baseUrl: BASE_URL });
    await client.targetsUp();

    expect(mock.mock.calls[0][0]).toBe(`${BASE_URL}/api/v1/targets`);
  });
});

// ---------------------------------------------------------------------------
// createPromClient + base URL handling + PromQL builders
// ---------------------------------------------------------------------------

describe("createPromClient", () => {
  it("returns a working HttpPromClient", async () => {
    stubFetchResolve(
      jsonResponse({ status: "success", data: { resultType: "vector", result: [] } }),
    );

    const client = createPromClient({ baseUrl: BASE_URL });
    expect(client).toBeInstanceOf(HttpPromClient);
    await expect(client.instant("up")).resolves.toEqual([]);
  });

  it("trims a trailing slash from the base URL so path joins stay clean", async () => {
    const mock = stubFetchResolve(
      jsonResponse({ status: "success", data: { resultType: "vector", result: [] } }),
    );

    const client = createPromClient({ baseUrl: `${BASE_URL}/` });
    await client.instant("up");

    const url = mock.mock.calls[0][0] as string;
    expect(url.startsWith(`${BASE_URL}/api/v1/query?`)).toBe(true);
    expect(url).not.toContain("//api/v1");
  });
});

describe("PromQL builders", () => {
  it("buildP95LatencyByLoadQuery groups p95 latency by the load label", () => {
    const q = buildP95LatencyByLoadQuery();
    expect(q).toContain("histogram_quantile(0.95");
    expect(q).toContain("http_request_duration_seconds_bucket");
    expect(q).toContain("by (le, load_level)");
    expect(q).toContain("[5m]");
  });

  it("buildP95LatencyByLoadQuery scopes to a route and escapes the value", () => {
    const q = buildP95LatencyByLoadQuery({ route: 'foo"bar' });
    expect(q).toContain('route="foo\\"bar"');
  });

  it("buildMemoryByVolumeQuery groups RSS by the data-volume label", () => {
    const q = buildMemoryByVolumeQuery();
    expect(q).toBe("max(process_resident_memory_bytes) by (data_volume)");
  });
});
