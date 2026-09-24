/**
 * Minimal HTTP health endpoint (plan §2/§7).
 * GET /health → 200 {status,lastTickAt,lastErrorAt} while the poller is
 * fresh (lastTickAt within 2× poll interval), else 503 so a dead poller
 * fails the Docker HEALTHCHECK instead of silently reporting healthy.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

export interface HealthState {
  lastTickAt: number | null;
  lastErrorAt: number | null;
}

export function startHealthServer(
  port: number,
  state: HealthState,
  pollIntervalMs: number,
): Promise<Server> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/health/")) {
      const now = Date.now();
      const fresh = state.lastTickAt !== null && now - state.lastTickAt <= 2 * pollIntervalMs;
      const body = JSON.stringify({
        status: fresh ? "ok" : "stale",
        lastTickAt: state.lastTickAt,
        lastErrorAt: state.lastErrorAt,
      });
      res.writeHead(fresh ? 200 : 503, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve(server));
  });
}
