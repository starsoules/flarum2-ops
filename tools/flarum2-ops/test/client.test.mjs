import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FlarumClient, FlarumError } from "../dist/flarum-client.js";

// Mock global fetch, capturing calls and returning a canned response.
let calls = [];
const origFetch = globalThis.fetch;
function stubFetch(body = {}, status = 200) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}
afterEach(() => {
  globalThis.fetch = origFetch;
});

test("read-only client refuses every mutating method (before any network call)", async () => {
  const c = new FlarumClient({ baseUrl: "http://forum.test", readOnly: true });
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    await assert.rejects(
      () => c.request({ method, path: "/discussions" }),
      /read-only/i,
      `${method} should be refused`,
    );
  }
});

test("read-only client still allows reads", async () => {
  stubFetch({ data: [] });
  const c = new FlarumClient({ baseUrl: "http://forum.test", readOnly: true });
  assert.deepEqual(await c.request({ path: "/discussions" }), { data: [] });
  assert.equal(calls.length, 1);
});

test("builds JSON:API query params (filter/include/fields/sort/page)", async () => {
  stubFetch({});
  const c = new FlarumClient({ baseUrl: "http://forum.test" });
  await c.request({
    path: "/discussions",
    query: {
      filter: { q: "hi" },
      include: "user",
      fields: { discussions: "title" },
      sort: "-createdAt",
      page: { limit: 5, offset: 10 },
    },
  });
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, "/api/discussions");
  assert.equal(u.searchParams.get("filter[q]"), "hi");
  assert.equal(u.searchParams.get("include"), "user");
  assert.equal(u.searchParams.get("fields[discussions]"), "title");
  assert.equal(u.searchParams.get("sort"), "-createdAt");
  assert.equal(u.searchParams.get("page[limit]"), "5");
  assert.equal(u.searchParams.get("page[offset]"), "10");
});

test("targets the /api root and normalises base URL", async () => {
  stubFetch({});
  const c = new FlarumClient({ baseUrl: "http://forum.test/" });
  await c.request({ path: "users/1" });
  assert.equal(new URL(calls[0].url).pathname, "/api/users/1");
});

test("sends Token auth header with userId", async () => {
  stubFetch({});
  const c = new FlarumClient({ baseUrl: "http://forum.test", apiKey: "KEY", userId: 1 });
  await c.request({ path: "/" });
  assert.equal(calls[0].init.headers.Authorization, "Token KEY; userId=1");
});

test("omits auth header when no key is set", async () => {
  stubFetch({});
  const c = new FlarumClient({ baseUrl: "http://forum.test" });
  await c.request({ path: "/" });
  assert.equal(calls[0].init.headers.Authorization, undefined);
});

test("sends User-Agent header when configured", async () => {
  stubFetch({});
  const c = new FlarumClient({ baseUrl: "http://forum.test", userAgent: "mcp-for-flarum/test" });
  await c.request({ path: "/" });
  assert.equal(calls[0].init.headers["User-Agent"], "mcp-for-flarum/test");
});

test("omits User-Agent header when not configured", async () => {
  stubFetch({});
  const c = new FlarumClient({ baseUrl: "http://forum.test" });
  await c.request({ path: "/" });
  assert.equal(calls[0].init.headers["User-Agent"], undefined);
});

test("GET never sends a body, even if one is passed", async () => {
  stubFetch({});
  const c = new FlarumClient({ baseUrl: "http://forum.test" });
  await c.request({ path: "/x", body: { a: 1 } });
  assert.equal(calls[0].init.body, undefined);
});

test("throws FlarumError carrying status and parsed body on non-2xx", async () => {
  const errBody = { errors: [{ status: "404", code: "not_found" }] };
  stubFetch(errBody, 404);
  const c = new FlarumClient({ baseUrl: "http://forum.test" });
  await assert.rejects(
    () => c.request({ path: "/discussions/999" }),
    (e) => {
      assert.ok(e instanceof FlarumError);
      assert.equal(e.status, 404);
      assert.deepEqual(e.body, errBody);
      return true;
    },
  );
});

test("a credential with a line break or space is refused without ever showing it", async () => {
  const { loadToken } = await import("../dist/config.js");
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const secret = "s3cr3t-token-value";
  const cfg = { tokenFile: "/nonexistent" };
  for (const bad of [`${secret}\r\nX-Evil: 1`, `${secret} extra`]) {
    assert.throws(() => loadToken(cfg, { FLARUM_API_KEY: bad }), (e) => /not allowed in an HTTP header/.test(e.message) && !e.message.includes(secret));
    assert.throws(() => new FlarumClient({ baseUrl: "http://forum.test", apiKey: bad }), (e) => !e.message.includes(secret));
  }
  const dir = mkdtempSync(join(tmpdir(), "flarum2-ops-tok-"));
  const file = join(dir, "token");
  writeFileSync(file, `${secret}\nsecond-line\n`);
  chmodSync(file, 0o600);
  assert.throws(() => loadToken({ tokenFile: file }, {}), (e) => /token file/.test(e.message) && !e.message.includes(secret));
  writeFileSync(file, `${secret}\n`); // a trailing newline alone is fine
  assert.equal(loadToken({ tokenFile: file }, {}).token, secret);
});

test("public_assets_subdir must be a single folder name", async () => {
  const { loadConfig } = await import("../dist/config.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "flarum2-ops-cfg-"));
  const file = join(dir, "forum.json");
  for (const bad of ["", "..", "a/b", "../x"]) {
    writeFileSync(file, JSON.stringify({ base_url: "http://forum.test", public_assets_subdir: bad }));
    assert.throws(() => loadConfig({ FLARUM2_OPS_CONFIG: file }), /public_assets_subdir/, JSON.stringify(bad));
  }
  writeFileSync(file, JSON.stringify({ base_url: "http://forum.test", public_assets_subdir: "themes_2" }));
  assert.equal(loadConfig({ FLARUM2_OPS_CONFIG: file }).publicAssetsSubdir, "themes_2");
});

test("paths with control characters never reach the network (tab/CR/LF vanish before dot segments are resolved)", async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => (sent.push(String(u)), new Response("{}", { status: 200 }));
  try {
    const c = new FlarumClient({ baseUrl: "http://forum.test/forum", apiKey: "abcdef123456" });
    for (const p of ["/.\t./.\t./forum/api/settings", "/sett\nings", "/a b", "/.\r./x"]) {
      await assert.rejects(() => c.raw({ method: "POST", path: p, body: {} }), /control characters|outside the API root/, JSON.stringify(p));
    }
    assert.equal(sent.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("redirects are never followed (a 307 would resend the body, e.g. the login password, to another host)", async () => {
  const { startMockFlarum, makeForumRoot } = await import("./helpers/mock-flarum.mjs");
  const mock = await startMockFlarum({ forumRoot: makeForumRoot() });
  const elsewhere = await startMockFlarum({ forumRoot: makeForumRoot() });
  try {
    mock.behaviour.redirectTo = elsewhere.base;
    const c = new FlarumClient({ baseUrl: mock.base, apiKey: "abcdef123456" });
    await assert.rejects(() => c.raw({ method: "POST", path: "/token", body: { identification: "admin", password: "pw-secret" } }), /307 with a redirect[\s\S]*not followed/);
    assert.equal(elsewhere.requests.length, 0, "nothing reached the other host");
  } finally {
    await mock.close();
    await elsewhere.close();
  }
});
