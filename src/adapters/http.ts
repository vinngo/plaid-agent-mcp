// Local entry point over streamable HTTP: `npm run dev`. Same transport the
// agent will use against Gateway, so the agent code doesn't change on deploy.
// Binds to loopback by default and refuses a public bind without MCP_API_KEY.

import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "../config.js";
import { defaultDeps } from "../core/deps.js";
import { log } from "../logger.js";
import { buildMcpServer } from "./mcp.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const { host, port, apiKey } = config.http;

if (!LOOPBACK.has(host) && !apiKey) {
  log.error("Refusing to bind a non-loopback HOST without MCP_API_KEY.", { host });
  process.exit(1);
}

function rpcError(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null });
}

function auth(req: Request, res: Response, next: NextFunction): void {
  // Block browsers from other origins (DNS rebinding); server clients send no Origin.
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return rpcError(res, 403, "Origin not allowed");
  if (apiKey) {
    const got = Buffer.from(req.headers.authorization ?? "");
    const want = Buffer.from(`Bearer ${apiKey}`);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return rpcError(res, 401, "Unauthorized");
  }
  next();
}

const deps = defaultDeps();
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", provider: config.providerKind, snapshots: config.snapshots.kind });
});

// Stateless: a fresh server + transport per request.
app.post("/mcp", auth, async (req, res) => {
  const server = buildMcpServer(deps);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    log.error("MCP request failed", { error: (err as Error).message });
    if (!res.headersSent) rpcError(res, 500, "Internal server error");
  }
});
app.all("/mcp", (_req, res) => rpcError(res, 405, "Use POST"));

app.listen(port, host, () => {
  log.info("plaid-agent MCP (http) ready", {
    url: `http://${host}:${port}/mcp`,
    provider: config.providerKind,
    snapshots: config.snapshots.kind,
    auth: Boolean(apiKey),
  });
  if (config.providerKind === "mock") log.warn("MOCK MODE: serving sample Fidelity/Robinhood data.");
});
