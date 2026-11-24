import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isLocalHost, hostAllowed, readBody } from "../dist/http.js";
import { PassThrough } from "node:stream";
import { cleanEnv, isolatedConfig } from "./helpers/env.mjs";

test("isLocalHost recognises local addresses only", () => {
  for (const h of ["127.0.0.1", "localhost", "::1"]) assert.equal(isLocalHost(h), true, h);
  for (const h of ["0.0.0.0", "example.com", "10.0.0.5", ""]) assert.equal(isLocalHost(h), false, h);
});

test("HTTP mode fails closed: refuses non-localhost bind without an auth token", () => {
  const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const env = cleanEnv({
    ...isolatedConfig(),
    MCP_TRANSPORT: "http",
    HOST: "0.0.0.0",
    FLARUM_URL: "http://forum.test",
    PORT: "0",
  }); // no MCP_AUTH_TOKEN, whatever the developer's shell exports
  const r = spawnSync(process.execPath, [entry], { env, encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status} (signal ${r.signal})`);
  assert.match(r.stderr, /Refusing to bind/);
});

test("DNS-rebinding guard: without a token only loopback Host/Origin are served", () => {
  const env = {};
  assert.equal(hostAllowed({ host: "127.0.0.1:3000" }, 3000, env), true);
  assert.equal(hostAllowed({ host: "localhost:3000", origin: "http://localhost:3000" }, 3000, env), true);
  assert.equal(hostAllowed({ host: "attacker.example:3000" }, 3000, env), false);
  assert.equal(hostAllowed({ host: "127.0.0.1:3000", origin: "http://attacker.example:3000" }, 3000, env), false);
  assert.equal(hostAllowed({ host: "127.0.0.1:3000", origin: "null" }, 3000, env), false, "sandboxed iframes / file:// send Origin: null");
  assert.equal(hostAllowed({ host: "127.0.0.1:4000" }, 3000, env), false);
  assert.equal(hostAllowed({}, 3000, env), false);
  assert.equal(hostAllowed({ host: "mcp.example.org" }, 3000, { MCP_ALLOWED_HOSTS: "mcp.example.org" }), true);
  assert.equal(hostAllowed({ host: "anything" }, 3000, { MCP_AUTH_TOKEN: "t" }), true);
  assert.equal(hostAllowed({ host: "other" }, 3000, { MCP_AUTH_TOKEN: "t", MCP_ALLOWED_HOSTS: "mcp.example.org" }), false);
});

test("the running HTTP server rejects a rebinding request (foreign Host) with 403", async () => {
  const { spawn } = await import("node:child_process");
  const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const env = cleanEnv({ ...isolatedConfig(), MCP_TRANSPORT: "http", HOST: "127.0.0.1", FLARUM_URL: "http://forum.test", PORT: "0" }); // no MCP_AUTH_TOKEN / MCP_ALLOWED_HOSTS
  const child = spawn(process.execPath, [entry], { env, stdio: ["ignore", "ignore", "pipe"] });
  try {
    const port = await new Promise((resolve, reject) => {
      let err = "";
      child.stderr.on("data", (d) => {
        err += d;
        const m = /listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(err);
        if (m) resolve(Number(m[1]));
      });
      child.on("exit", () => reject(new Error(err)));
    });
    const { request } = await import("node:http");
    const status = (host) =>
      new Promise((resolve, reject) => {
        const r = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { Host: host, "Content-Type": "application/json" } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        r.on("error", reject);
        r.end("{}");
      });
    assert.equal(await status(`attacker.example:${port}`), 403);
    assert.notEqual(await status(`127.0.0.1:${port}`), 403);
    // Request targets that are not URLs ("//", "//[") get a 400; the server must stay up.
    const rawStatus = (target) =>
      new Promise((resolve, reject) => {
        const r = request({ host: "127.0.0.1", port, path: target, method: "GET", headers: { Host: `127.0.0.1:${port}` } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        r.on("error", reject);
        r.end();
      });
    for (const target of ["//", "//["]) assert.equal(await rawStatus(target), 400, target);
    assert.equal(await rawStatus("/health"), 200, "still running");
  } finally {
    child.kill();
  }
});

test("readBody keeps multi-byte characters split across chunks, caps the size and rejects invalid JSON", async () => {
  const feed = (parts) => {
    const req = new PassThrough();
    req.destroy = () => {};
    setImmediate(() => {
      for (const p of parts) req.write(p);
      req.end();
    });
    return req;
  };
  const json = Buffer.from(JSON.stringify({ less: "ä".repeat(10) }));
  const cut = json.indexOf(0xc3) + 1; // split inside the first "ä"
  assert.deepEqual(await readBody(feed([json.subarray(0, cut), json.subarray(cut)])), { less: "ä".repeat(10) });
  await assert.rejects(() => readBody(feed([Buffer.alloc(20, 32)]), 10), (e) => e.status === 413);
  await assert.rejects(() => readBody(feed([Buffer.from("{nope")])), (e) => e.status === 400);
  assert.equal(await readBody(feed([])), undefined);
});

test("with MCP_AUTH_TOKEN set, a request without the bearer token gets 401, one with it does not", async () => {
  const { spawn } = await import("node:child_process");
  const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const env = cleanEnv({ ...isolatedConfig(), MCP_TRANSPORT: "http", HOST: "127.0.0.1", FLARUM_URL: "http://forum.test", PORT: "0", MCP_AUTH_TOKEN: "s3cret-token-xyz" });
  const child = spawn(process.execPath, [entry], { env, stdio: ["ignore", "ignore", "pipe"] });
  try {
    const port = await new Promise((resolve, reject) => {
      let err = "";
      child.stderr.on("data", (d) => {
        err += d;
        const m = /listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(err);
        if (m) resolve(Number(m[1]));
      });
      child.on("exit", () => reject(new Error(err)));
    });
    const { request } = await import("node:http");
    const status = (auth) =>
      new Promise((resolve, reject) => {
        const headers = { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) };
        const r = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        r.on("error", reject);
        r.end("{}");
      });
    assert.equal(await status(undefined), 401);
    assert.equal(await status("Bearer wrong-token-xyzz"), 401);
    assert.notEqual(await status("Bearer s3cret-token-xyz"), 401);
  } finally {
    child.kill();
  }
});
