import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { loadDotEnv } from "../loadEnv.js";
import { WindowSession } from "../session.js";
import { parseCliFlags } from "../cli/flags.js";
import type { SessionConfig, TickSnapshot } from "../domain.js";

type Envelope =
  | { type: "snapshot"; snap: TickSnapshot }
  | { type: "control"; running: boolean; error?: string };

type PublicConfig = {
  liveTrading: boolean;
  liveSource: string;
  threshold: number;
  betUsd: number;
  maxAsk: number;
  minEdge: number;
  minSecondsToEnter: number;
  maxEntersPerWindow: number;
  tickMs: number;
  windowLengthSec: number;
};

const dashboardPath = fileURLToPath(new URL("./dashboard.html", import.meta.url));

const clients = new Set<ServerResponse>();
let latest: TickSnapshot | null = null;
let session: WindowSession | null = null;
let running = false;
let cfg: SessionConfig | null = null;
let configError: string | null = null;

function publicConfig(): PublicConfig | null {
  if (!cfg) return null;
  return {
    liveTrading: cfg.liveTrading,
    liveSource: process.env.POLYMARKET_SOURCE ?? "auto",
    threshold: cfg.threshold,
    betUsd: cfg.betUsd,
    maxAsk: cfg.maxAsk,
    minEdge: cfg.minEdge,
    minSecondsToEnter: cfg.minSecondsToEnter,
    maxEntersPerWindow: cfg.maxEntersPerWindow,
    tickMs: cfg.tickMs,
    windowLengthSec: cfg.windowLengthSec,
  };
}

function broadcast(env: Envelope): void {
  const payload = `data: ${JSON.stringify(env)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

async function startSession(): Promise<void> {
  if (running || !cfg) return;
  session = await WindowSession.open(cfg);
  running = true;
  broadcast({ type: "control", running });
  session.run((snap) => {
    latest = snap;
    broadcast({ type: "snapshot", snap });
  });
}

async function stopSession(): Promise<void> {
  const active = session;
  session = null;
  running = false;
  if (active) {
    try {
      await active.close();
    } catch {
      /* already gone */
    }
  }
  broadcast({ type: "control", running });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function handleEvents(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2000\n\n");
  if (latest) {
    res.write(`data: ${JSON.stringify({ type: "snapshot", snap: latest })}\n\n`);
  }
  res.write(
    `data: ${JSON.stringify({
      type: "control",
      running,
      error: configError ?? undefined,
    })}\n\n`,
  );
  clients.add(res);

  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* dropped below */
    }
  }, 15_000);

  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    // Read on every request so dashboard edits apply on refresh (no restart).
    let html: string;
    try {
      html = await readFile(dashboardPath, "utf8");
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: `dashboard.html unreadable: ${String(err)}`,
      });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(html);
    return;
  }

  if (req.method === "GET" && path === "/events") {
    handleEvents(req, res);
    return;
  }

  if (req.method === "GET" && path === "/api/state") {
    sendJson(res, 200, {
      running,
      error: configError,
      latest,
      config: publicConfig(),
    });
    return;
  }

  if (req.method === "POST" && path === "/api/control") {
    const body = (await readBody(req)) as { action?: string };
    const action = body.action;
    if (action === "start") {
      if (configError) {
        sendJson(res, 409, { ok: false, error: configError });
        return;
      }
      try {
        await startSession();
        sendJson(res, 200, { ok: true, running });
      } catch (err) {
        configError = err instanceof Error ? err.message : String(err);
        broadcast({ type: "control", running, error: configError });
        sendJson(res, 500, { ok: false, error: configError });
      }
      return;
    }
    if (action === "stop") {
      await stopSession();
      sendJson(res, 200, { ok: true, running });
      return;
    }
    sendJson(res, 400, { ok: false, error: "action must be start or stop" });
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
}

async function main(): Promise<void> {
  loadDotEnv();
  const flags = parseCliFlags(process.argv.slice(2));
  try {
    cfg = loadConfig(process.env, {
      stubJudge: flags.stubJudge,
      fixedSpot: flags.fixedSpot,
      stubConfidence: flags.stubConfidence,
      stubSide: flags.stubSide,
    });
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(err) });
      else res.end();
    });
  });

  const port = Number(process.env.WEB_PORT ?? 3000);
  const host = process.env.WEB_HOST ?? "127.0.0.1";

  server.listen(port, host, () => {
    console.log(`JEV dashboard → http://${host}:${port}`);
    if (cfg) {
      startSession().catch((err) => {
        configError = err instanceof Error ? err.message : String(err);
        broadcast({ type: "control", running, error: configError });
      });
    }
  });

  const shutdown = async () => {
    await stopSession();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
