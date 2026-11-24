import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { FlarumClient } from "../dist/flarum-client.js";
import { registerTools } from "../dist/tools/index.js";

// Collect registered tools via a stub server, then drive their handlers the
// way the real MCP server would: validate raw args through the tool's zod
// shape (applying defaults/clamps) before calling the handler.
function register(client) {
  const tools = new Map();
  registerTools({ registerTool: (name, cfg, handler) => tools.set(name, { cfg, handler }) }, client);
  return tools;
}
const call = (tool, raw = {}) => tool.handler(z.object(tool.cfg.inputSchema).parse(raw));
const writeClient = () => new FlarumClient({ baseUrl: "http://forum.test", readOnly: false });
const readClient = () => new FlarumClient({ baseUrl: "http://forum.test", readOnly: true });

let calls = [];
const origFetch = globalThis.fetch;
function stubFetch(body = {}, status = 200) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}
afterEach(() => {
  globalThis.fetch = origFetch;
});

const WRITE_TOOLS = ["flarum_create", "flarum_update", "flarum_delete", "flarum_create_discussion", "flarum_reply"];

test("write mode registers all 10 tools", () => {
  const t = register(writeClient());
  assert.equal(t.size, 10);
  for (const n of WRITE_TOOLS) assert.ok(t.has(n), `missing ${n}`);
});

test("read-only mode hides mutation tools, leaving 5 read tools", () => {
  const t = register(readClient());
  assert.deepEqual(
    [...t.keys()].sort(),
    ["flarum_get", "flarum_list", "flarum_request", "flarum_search", "flarum_whoami"],
  );
  for (const n of WRITE_TOOLS) assert.ok(!t.has(n), `${n} should not be registered`);
});

test("flarum_request refuses non-GET in read-only and never hits the network", async () => {
  stubFetch();
  const t = register(readClient());
  const res = await call(t.get("flarum_request"), { method: "POST", path: "/discussions", body: { x: 1 } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /read-only/i);
  assert.equal(calls.length, 0);
});

test("flarum_request allows GET in read-only", async () => {
  stubFetch({ data: [] });
  const t = register(readClient());
  const res = await call(t.get("flarum_request"), { method: "GET", path: "/discussions" });
  assert.ok(!res.isError);
  assert.equal(calls.length, 1);
});

test("flarum_request POST with an object body reaches the network single-encoded", async () => {
  stubFetch({});
  const t = register(writeClient());
  await call(t.get("flarum_request"), {
    method: "POST",
    path: "/custom-route",
    body: { custom_less: "body{}" },
    confirm: true,
  });
  assert.equal(calls[0].init.method, "POST");
  // One layer of JSON: decoding once yields the object, not a string.
  assert.deepEqual(JSON.parse(calls[0].init.body), { custom_less: "body{}" });
});

test("flarum_request normalizes a JSON-string body so it is not double-encoded", async () => {
  // The MCP transport can hand the free-form `body` over already stringified;
  // the client stringifies again, which used to reach Flarum double-encoded and
  // 500 in ParseJsonBody. The handler must decode the string back to an object.
  stubFetch({});
  const t = register(writeClient());
  await call(t.get("flarum_request"), {
    method: "POST",
    path: "/custom-route",
    body: '{"custom_less":"body{}"}',
    confirm: true,
  });
  const decoded = JSON.parse(calls[0].init.body);
  assert.equal(typeof decoded, "object");
  assert.deepEqual(decoded, { custom_less: "body{}" });
});

test("flarum_request leaves a genuine non-JSON string body untouched", async () => {
  stubFetch({});
  const t = register(writeClient());
  await call(t.get("flarum_request"), { method: "POST", path: "/raw", body: "hello world", confirm: true });
  // Not JSON-structured: passed through as-is (client still JSON-encodes it).
  assert.equal(calls[0].init.body, JSON.stringify("hello world"));
});

test("flarum_list maps to GET with paging/fields/filter and defaults limit to 20", async () => {
  stubFetch({ data: [] });
  const t = register(writeClient());
  await call(t.get("flarum_list"), { type: "users", filter: { q: "bob" }, fields: { users: "username" } });
  const u = new URL(calls[0].url);
  assert.equal(calls[0].init.method ?? "GET", "GET");
  assert.equal(u.pathname, "/api/users");
  assert.equal(u.searchParams.get("filter[q]"), "bob");
  assert.equal(u.searchParams.get("fields[users]"), "username");
  assert.equal(u.searchParams.get("page[limit]"), "20");
});

test("flarum_list rejects a page size over the max of 50", () => {
  const t = register(writeClient());
  assert.throws(() => z.object(t.get("flarum_list").cfg.inputSchema).parse({ type: "posts", limit: 999 }));
});

test("flarum_create issues POST with a JSON:API body", async () => {
  stubFetch({ data: { type: "discussions", id: "1" } });
  const t = register(writeClient());
  await call(t.get("flarum_create"), {
    confirm: true,
    type: "discussions",
    attributes: { title: "x" },
    relationships: { tags: { data: [] } },
  });
  assert.equal(calls[0].init.method, "POST");
  assert.equal(new URL(calls[0].url).pathname, "/api/discussions");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    data: { type: "discussions", attributes: { title: "x" }, relationships: { tags: { data: [] } } },
  });
});

test("flarum_update issues PATCH with the id in path and body", async () => {
  stubFetch({ data: {} });
  const t = register(writeClient());
  await call(t.get("flarum_update"), { type: "discussions", id: "42", attributes: { isLocked: true }, confirm: true });
  assert.equal(calls[0].init.method, "PATCH");
  assert.equal(new URL(calls[0].url).pathname, "/api/discussions/42");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    data: { type: "discussions", id: "42", attributes: { isLocked: true } },
  });
});

// A relationship-only PATCH must still carry an attributes key. Without it,
// flarum/subscriptions' Saving listener reads $data['attributes'] as null and
// throws, 500ing every tags-only update on a default forum.
test("flarum_update sends an empty attributes object when only relationships change", async () => {
  stubFetch({ data: {} });
  const t = register(writeClient());
  await call(t.get("flarum_update"), {
    confirm: true,
    type: "discussions",
    id: "42",
    relationships: { tags: { data: [{ type: "tags", id: "2" }] } },
  });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    data: {
      type: "discussions",
      id: "42",
      attributes: {},
      relationships: { tags: { data: [{ type: "tags", id: "2" }] } },
    },
  });
});

test("flarum_delete issues DELETE and returns a deleted marker", async () => {
  stubFetch({});
  const t = register(writeClient());
  const res = await call(t.get("flarum_delete"), { type: "posts", id: "7", confirm: true });
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(new URL(calls[0].url).pathname, "/api/posts/7");
  assert.deepEqual(JSON.parse(res.content[0].text), { deleted: true, type: "posts", id: "7" });
});

test("maxFieldChars truncates long fields, and 0 disables truncation", async () => {
  const long = "a".repeat(2000);
  const doc = () => ({ data: [{ type: "posts", id: "1", attributes: { contentHtml: long } }] });

  stubFetch(doc());
  const t = register(writeClient());
  const trimmed = await call(t.get("flarum_list"), { type: "posts", maxFieldChars: 100 });
  assert.match(trimmed.content[0].text, /\[truncated 1900 chars\]/);
  assert.ok(!trimmed.content[0].text.includes(long));

  stubFetch(doc());
  const full = await call(t.get("flarum_list"), { type: "posts", maxFieldChars: 0 });
  assert.ok(!full.content[0].text.includes("[truncated"));
  assert.ok(full.content[0].text.includes(long));
});

test("API errors surface as an isError result containing the API body", async () => {
  stubFetch({ errors: [{ status: "403", detail: "nope" }] }, 403);
  const t = register(writeClient());
  const res = await call(t.get("flarum_get"), { type: "discussions", id: "1" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /403/);
  assert.match(res.content[0].text, /nope/);
});

test("every write tool is a dry run without confirm and never hits the network", async () => {
  stubFetch({});
  const t = register(writeClient());
  const args = {
    flarum_create: { type: "discussions", attributes: { title: "x" } },
    flarum_update: { type: "discussions", id: "1", attributes: { isLocked: true } },
    flarum_delete: { type: "users", id: "5" },
    flarum_create_discussion: { title: "t", content: "c" },
    flarum_reply: { discussionId: "1", content: "c" },
    flarum_request: { method: "DELETE", path: "/api/discussions/3" },
  };
  for (const [name, a] of Object.entries(args)) {
    const res = await call(t.get(name), a);
    const out = JSON.parse(res.content[0].text);
    assert.equal(out.dryRun, true, name);
    assert.ok(out.wouldSend, name);
  }
  assert.equal(calls.length, 0);
});

test("flarum_request refuses writes to endpoints that have a policy-checked tool, even with confirm", async () => {
  stubFetch({});
  const t = register(writeClient());
  const cases = [
    ["POST", "/settings"], ["DELETE", "/api/settings"], ["PATCH", "/extensions/flarum-gdpr"], ["POST", "/permission"], ["DELETE", "/logo"],
    // spellings that reach the same route
    ["POST", "/settings?x=1"], ["POST", "/settings#a"], ["POST", "/settings/"], ["POST", "//settings"], ["POST", "/x/../settings"],
    ["POST", "/./settings"], ["POST", "/%73ettings"], ["POST", "/Settings"], ["PATCH", "/extensions/flarum-gdpr?y"],
  ];
  for (const [method, path] of cases) {
    const res = await call(t.get("flarum_request"), { method, path, body: { extensions_enabled: "[]" }, confirm: true });
    assert.equal(res.isError, true, `${method} ${path}`);
    assert.match(res.content[0].text, /use flarum_|must not contain "\." or "\.\." segments/);
  }
  assert.equal(calls.length, 0);
});

test("generic create/update/delete cannot reach managed endpoints (uninstall, toggle, settings), even with confirm", async () => {
  stubFetch({});
  const t = register(writeClient());
  const cases = [
    ["flarum_delete", { type: "extensions", id: "flarum-tags", confirm: true }], // core: uninstall + migrateDown
    ["flarum_update", { type: "extensions", id: "flarum-tags", attributes: { enabled: true }, confirm: true }], // core reads top-level enabled -> disables
    ["flarum_create", { type: "settings", attributes: { extensions_enabled: "[]" }, confirm: true }],
    ["flarum_delete", { type: "Extensions", id: "x", confirm: true }],
  ];
  for (const [name, args] of cases) {
    const res = await call(t.get(name), args);
    assert.equal(res.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(res.content[0].text, /refused here/);
  }
  assert.equal(calls.length, 0);
});

test("type/id must be single path segments, so they cannot be used to walk to other routes", () => {
  const t = register(writeClient());
  const schema = (n) => z.object(t.get(n).cfg.inputSchema);
  for (const bad of [{ type: "../settings", id: "1" }, { type: "discussions", id: "../../settings" }, { type: "a/b", id: "1" }, { type: "..", id: "1" }]) {
    assert.equal(schema("flarum_delete").safeParse(bad).success, false, JSON.stringify(bad));
  }
  assert.equal(schema("flarum_delete").safeParse({ type: "fof-upload-files", id: "a1b2.c" }).success, true);
});

test("flarum_request also refuses extension bisect, the extension manager and cache clear", async () => {
  stubFetch({});
  const t = register(writeClient());
  for (const [method, path] of [["POST", "/extension-bisect"], ["POST", "/extension-manager/extensions"], ["PATCH", "/extension-manager/extensions/fof-upload"], ["DELETE", "/cache"]]) {
    const res = await call(t.get("flarum_request"), { method, path, confirm: true });
    assert.equal(res.isError, true, `${method} ${path}`);
  }
  assert.equal(calls.length, 0);
});

test("dot segments never reach the network, so a forum in a subfolder cannot be walked to its own /api/settings", async () => {
  stubFetch({});
  const sub = new FlarumClient({ baseUrl: "http://forum.test/forum", readOnly: false });
  const t = register(sub);
  for (const path of ["/../../forum/api/settings", "/x/%2e%2e/settings", "/..\\settings", "/./settings"]) {
    const res = await call(t.get("flarum_request"), { method: "POST", path, body: { extensions_enabled: "[]" }, confirm: true });
    assert.equal(res.isError, true, path);
  }
  for (const path of ["/../../forum/api/access-tokens", "/discussions/.."]) {
    const res = await call(t.get("flarum_request"), { method: "GET", path });
    assert.equal(res.isError, true, path);
  }
  assert.equal(calls.length, 0);
});

test("access tokens never reach the agent: token attributes and our own credential are masked, token writes refused", async () => {
  const secret = "dev-token-abcdef123456";
  const doc = { data: [{ type: "access-tokens", id: "7", attributes: { token: "other-token-999999", title: "ci" } }], included: [{ type: "access-tokens", id: "8", attributes: { token: secret } }], meta: { echo: secret } };
  stubFetch(doc);
  const c = new FlarumClient({ baseUrl: "http://forum.test", apiKey: secret, readOnly: true });
  const t = register(c);
  const out = (await call(t.get("flarum_list"), { type: "access-tokens" })).content[0].text;
  assert.equal(out.includes(secret), false);
  assert.equal(out.includes("other-token-999999"), false);
  assert.match(out, /"title": "ci"/);
  stubFetch({});
  const w = register(writeClient());
  for (const [name, args] of [["flarum_create", { type: "access-tokens", attributes: { title: "x" }, confirm: true }], ["flarum_delete", { type: "access-tokens", id: "7", confirm: true }]]) {
    assert.equal((await call(w.get(name), args)).isError, true, name);
  }
  assert.equal(calls.length, 0);
});
