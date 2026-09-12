// Entry point for the target app.
//
// Starts the HTTP server and, optionally, a self-driven load loop so that the
// APM system has live, varied traffic to observe without an external load tool.
import { createApp } from "./server";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
// Set SELF_LOAD=0 to disable the built-in traffic generator.
const SELF_LOAD = process.env.SELF_LOAD !== "0";

function startSelfLoad(baseUrl: string): void {
  // Fire occasional requests at varied load levels so the complexity fitter
  // accumulates distinct (load, latency) pairs over time.
  const loadLevels = [1, 5, 10, 25, 50, 100, 200];
  setInterval(() => {
    const n = loadLevels[Math.floor(Math.random() * loadLevels.length)];
    const path = Math.random() < 0.25 ? "/flaky" : `/work?n=${n}`;
    fetch(`${baseUrl}${path}`).catch(() => {
      /* ignore self-load errors */
    });
  }, 2000);
}

function main(): void {
  const { server } = createApp();
  server.listen(PORT, HOST, () => {
    const baseUrl = `http://127.0.0.1:${PORT}`;
    // eslint-disable-next-line no-console
    console.log(`target-app listening on http://${HOST}:${PORT}`);
    // eslint-disable-next-line no-console
    console.log(`metrics at ${baseUrl}/metrics`);
    if (SELF_LOAD && typeof fetch === "function") {
      startSelfLoad(baseUrl);
      // eslint-disable-next-line no-console
      console.log("self-load generator enabled (set SELF_LOAD=0 to disable)");
    }
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
