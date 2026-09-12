// HTTP server for the target app.
//
// Built on Node's built-in `http` module (no extra web-framework dependency,
// keeping the footprint minimal and cost-free). Exposes:
//   GET /metrics          -> Prometheus text exposition format (Requirement 1.1)
//   GET /                  -> liveness/info
//   GET /work?n=<int>      -> load-generating route with load-proportional latency
//                             so the complexity engine has real (load, latency) data
//   GET /flaky             -> randomly returns 500 to exercise error-count metrics
import { createServer, IncomingMessage, ServerResponse, Server } from "http";
import { URL } from "url";
import { createMetrics, recordRequest, Metrics } from "./metrics";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Produce latency that grows roughly linearly with the `n` load parameter,
 * plus a little jitter. This gives the empirical complexity fitter varied,
 * load-dependent (load, latency) pairs to fit against (Requirement 2.1, and
 * the "load-generating route" part of task 1.4).
 */
function simulatedWorkMs(n: number): number {
  const base = 5; // fixed overhead
  const perUnit = 1.5; // linear growth per load unit
  const jitter = Math.random() * 10;
  return base + n * perUnit + jitter;
}

function parseLoad(url: URL): number {
  const raw = url.searchParams.get("n");
  const n = raw === null ? 10 : Number(raw);
  if (!Number.isFinite(n) || n < 0) return 10;
  // Clamp to keep the demo responsive.
  return Math.min(Math.floor(n), 500);
}

async function handleRequest(
  metrics: Metrics,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const start = process.hrtime.bigint();
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // Route label is the pathname (not the full URL) to avoid label cardinality
  // explosions from query strings.
  let route = path;
  let statusCode = 200;

  try {
    if (path === "/metrics" && method === "GET") {
      const body = await metrics.registry.metrics();
      res.writeHead(200, {
        "Content-Type": metrics.registry.contentType,
      });
      res.end(body);
      // The /metrics scrape itself is intentionally not recorded as app traffic.
      return;
    }

    if (path === "/" && method === "GET") {
      const body = JSON.stringify({
        name: "target-app",
        status: "ok",
        routes: ["/metrics", "/work?n=<int>", "/flaky"],
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    } else if (path === "/work" && method === "GET") {
      const n = parseLoad(url);
      await sleep(simulatedWorkMs(n));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ processed: n }));
    } else if (path === "/flaky" && method === "GET") {
      // ~30% error rate to exercise the error-count metric.
      if (Math.random() < 0.3) {
        statusCode = 500;
        await sleep(simulatedWorkMs(5));
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "simulated failure" }));
      } else {
        await sleep(simulatedWorkMs(5));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
    } else {
      statusCode = 404;
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  } catch (err) {
    statusCode = 500;
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  } finally {
    const durationSeconds =
      Number(process.hrtime.bigint() - start) / 1_000_000_000;
    recordRequest(metrics, { method, route, statusCode, durationSeconds });
  }
}

export interface TargetApp {
  server: Server;
  metrics: Metrics;
}

/** Create the HTTP server with its own metrics registry. Does not start listening. */
export function createApp(): TargetApp {
  const metrics = createMetrics();
  const server = createServer((req, res) => {
    void handleRequest(metrics, req, res);
  });
  return { server, metrics };
}
