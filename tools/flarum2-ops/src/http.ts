import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { clientFromEnv, createMcpServer, opsFromEnv } from "./server.js";

/**
 * Run the MCP server over Streamable HTTP so it can be hosted.
 *
 * Stateless mode: each POST /mcp request spins up a fresh server + transport,
 * which keeps tenants isolated and is the most robust shape for a hosted /
 * load-balanced deployment. If MCP_AUTH_TOKEN is set, requests must present a
 * matching `Authorization: Bearer <token>` (a minimal gate; OAuth can layer on
 * later for a multi-tenant product).
 */

const JSONRPC_UNAUTHORIZED = {
  jsonrpc: "2.0",
  error: { code: -32001, message: "Unauthorized" },
  id: null,
};

export const MAX_BODY_BYTES = 4_000_000;

export class BodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Collect the raw bytes and decode once: decoding per chunk splits multi-byte UTF-8 characters at chunk borders
 * (LESS, HTML or posts would arrive with U+FFFD). Oversized bodies stop the upload; invalid JSON is a 400, not an
 * empty request.
 */
export function readBody(req: IncomingMessage, max = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const fail = (e: Error) => {
      if (done) return;
      done = true;
      reject(e);
    };
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > max) {
        fail(new BodyError(413, "Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new BodyError(400, "Request body is not valid JSON"));
      }
    });
    req.on("error", fail);
  });
}

function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) return true; // no gate configured
  const got = Buffer.from(String(req.headers["authorization"] ?? ""));
  const want = Buffer.from(`Bearer ${expected}`);
  // Constant-time comparison (equal lengths required by timingSafeEqual).
  return got.length === want.length && timingSafeEqual(got, want);
}

export function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * DNS-rebinding guard for the unauthenticated (localhost-only) mode: a web page can make the browser send
 * requests to 127.0.0.1 under its own host name, so only requests whose Host is a loopback name (or one listed
 * in MCP_ALLOWED_HOSTS) and whose Origin, if any, belongs to such a host are served. With MCP_AUTH_TOKEN set the
 * bearer token is the gate and Host is only checked when MCP_ALLOWED_HOSTS is given (reverse proxies).
 */
export function hostAllowed(
  headers: { host?: string; origin?: string },
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const extra = (env.MCP_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (env.MCP_AUTH_TOKEN && !extra.length) return true;
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...extra]);
  const host = (headers.host ?? "").toLowerCase();
  if (!allowed.has(host)) return false;
  if (headers.origin) {
    let originHost: string;
    try {
      originHost = new URL(headers.origin).host.toLowerCase();
    } catch {
      return false;
    }
    if (!allowed.has(originHost)) return false;
  }
  return true;
}

export async function runHttp(): Promise<void> {
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  // Fail-closed: bind to localhost by default, and refuse to expose a
  // non-localhost interface without an auth token.
  const host = process.env.HOST ?? "127.0.0.1";
  if (!isLocalHost(host) && !process.env.MCP_AUTH_TOKEN) {
    process.stderr.write(
      `[flarum2-ops] Refusing to bind ${host} without MCP_AUTH_TOKEN set.\n` +
        "Set MCP_AUTH_TOKEN (or bind HOST=127.0.0.1 for local-only use).\n",
    );
    process.exit(1);
  }
  // Validate config up front so misconfig fails fast, not on first request.
  clientFromEnv();

  // Every request runs inside handle(); anything it throws becomes a 500 for that request. An uncaught exception in an
  // async request handler would end the whole process, and with it any apply/preview running there, without rollback.
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((err: unknown) => {
      try {
        process.stderr.write(`[flarum2-ops] http request error: ${(err as Error)?.stack ?? err}\n`);
      } catch {
        /* stderr gone */
      }
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
      } else {
        res.destroy();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      // e.g. a request target of "//" or "//[": not a path this server serves.
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "Bad request target" }, id: null }));
      return;
    }
    const boundPort = (httpServer.address() as { port: number } | null)?.port ?? port;

    if (!hostAllowed({ host: req.headers.host, origin: req.headers.origin }, boundPort)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Host or Origin not allowed (set MCP_ALLOWED_HOSTS)" }, id: null }));
      return;
    }

    // Lightweight health check for load balancers / uptime monitors.
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", name: "flarum2-ops" }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. POST to /mcp." }));
      return;
    }

    if (!authorized(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify(JSONRPC_UNAUTHORIZED));
      return;
    }

    if (req.method !== "POST") {
      // Stateless mode does not support GET (SSE) or session DELETE.
      res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Use POST." }, id: null }));
      return;
    }

    // May throw (token file or forum.json became invalid): handled by the catch around handle().
    const client = clientFromEnv();
    const server = createMcpServer(client, opsFromEnv(client));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    // Tear down per-request resources when the connection closes.
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      const body = await readBody(req);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (err instanceof BodyError) {
        if (!res.headersSent) {
          res.writeHead(err.status, { "Content-Type": "application/json", Connection: "close" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: err.message }, id: null }));
        }
        return;
      }
      process.stderr.write(`[flarum2-ops] http request error: ${(err as Error).stack ?? err}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
      }
    }
  }

  httpServer.listen(port, host, () => {
    process.stderr.write(
      `[flarum2-ops] HTTP transport listening on http://${host}:${(httpServer.address() as { port: number }).port}/mcp` +
        `${process.env.MCP_AUTH_TOKEN ? " (bearer auth on)" : " (localhost only, no auth token set)"}\n`,
    );
  });
}
