import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FlarumClient, normalizeApiPath, parseBody } from "../dist/flarum-client.js";
import { Ops, OpsError } from "../dist/ops.js";
import { whoami, requireAdmin, loginAndStore, insecureLoginWarning } from "../dist/auth.js";
import { classifyKey, lintLess, validateValue, checkSettingsWrite, normaliseValue, isSecretKey } from "../dist/policy.js";
import { sniffImage, checkUpload } from "../dist/images.js";
import { startMockFlarum, makeForumRoot, ADMIN_TOKEN, MEMBER_TOKEN, pngBytes } from "./helpers/mock-flarum.mjs";

// ------------------------------------------------------------- client fixes

test("normalizeApiPath strips an accidental /api prefix (the mcp-for-flarum /api/api trap)", () => {
  assert.equal(normalizeApiPath("/api/settings"), "/settings");
  assert.equal(normalizeApiPath("api/settings"), "/settings");
  assert.equal(normalizeApiPath("/settings"), "/settings");
  assert.equal(normalizeApiPath("settings"), "/settings");
  assert.equal(normalizeApiPath("/api"), "/");
  assert.equal(normalizeApiPath("/api/"), "/");
  assert.equal(normalizeApiPath("/apis/x"), "/apis/x");
  assert.throws(() => normalizeApiPath("http://x/api/settings"), /not a full URL/);
});

test("parseBody parses NDJSON streams into arrays and empty bodies into null", () => {
  assert.deepEqual(parseBody('{"type":"a"}\n{"type":"b"}\n', "application/x-ndjson"), [{ type: "a" }, { type: "b" }]);
  assert.equal(parseBody("", "application/json"), null);
  assert.equal(parseBody("plain", "text/plain"), "plain");
});

// ---------------------------------------------------------------- policy

test("classifyKey separates theme, optional, extension, protected and forbidden keys", () => {
  assert.equal(classifyKey("custom_less"), "theme");
  assert.equal(classifyKey("welcome_title"), "optional");
  assert.equal(classifyKey("flarum-tags.max_primary_tags", ["flarum-tags"]), "extension");
  assert.equal(classifyKey("fof-upload.mimeTypes", ["fof-upload"]), "extension");
  assert.equal(classifyKey("mail_password"), "protected");
  assert.equal(classifyKey("maintenance_mode"), "protected");
  assert.equal(classifyKey("extensions_enabled"), "forbidden");
  assert.equal(classifyKey("logo_path"), "forbidden");
  assert.equal(classifyKey("custom_less_error"), "forbidden");
  assert.equal(classifyKey("something_unknown"), "other");
});

test("validateValue enforces hex colors, color_scheme ids, booleans and routes", () => {
  assert.equal(validateValue("theme_primary_color", "#12abEF").length, 0);
  assert.equal(validateValue("theme_primary_color", "red")[0].level, "error");
  assert.equal(validateValue("theme_primary_color", "#fff;@import 'x'").some((i) => i.level === "error"), true);
  assert.equal(validateValue("color_scheme", "dark-hc").length, 0);
  assert.equal(validateValue("color_scheme", "midnight")[0].level, "error");
  assert.equal(validateValue("theme_colored_header", "yes")[0].level, "error");
  assert.equal(validateValue("default_route", "tags")[0].level, "error");
  assert.equal(validateValue("custom_footer", "<script>x()</script>")[0].level, "warning");
  assert.equal(validateValue("custom_less", "x".repeat(65001)).some((i) => /65000/.test(i.message)), true);
  assert.equal(normaliseValue("theme_colored_header", true), "1");
  assert.equal(normaliseValue("show_theme_selector", "false"), "0");
});

test("lintLess catches data-uri, local/protocol-relative imports, slash division and braces", () => {
  const msgs = (s) => lintLess(s).map((i) => `${i.level}:${i.message}`);
  assert.ok(msgs("a{b:data-uri('x.png')}").some((m) => m.startsWith("error") && /data-uri/.test(m)));
  assert.ok(msgs("@import 'theme.less';").some((m) => m.startsWith("error") && /local @import/.test(m)));
  assert.ok(msgs("@import url(//fonts.example/x.css);").some((m) => m.startsWith("error") && /protocol-relative/.test(m)));
  assert.ok(msgs("@import url(https://fonts.example/x.css);").some((m) => m.startsWith("warning") && /GDPR/.test(m)));
  assert.ok(msgs(".a{grid-column: 1 / 3;}").some((m) => m.startsWith("warning") && /division/.test(m)));
  assert.equal(msgs('.a{grid-column: ~"1 / 3";}').length, 0);
  assert.ok(msgs(".a{color:red;").some((m) => /unbalanced/.test(m)));
  assert.equal(msgs("// data-uri( in a comment\n/* @import 'x'; */ .a{color:red}").length, 0);
});

test("checkSettingsWrite refuses forbidden keys and gates protected ones", () => {
  const r = checkSettingsWrite({ extensions_enabled: "[]", mail_password: "x", theme_primary_color: "#000000" }, { enabledExtensions: [] });
  assert.ok(r.issues.some((i) => i.key === "extensions_enabled" && i.level === "error"));
  assert.ok(r.issues.some((i) => i.key === "mail_password" && /protected/.test(i.message)));
  assert.equal(r.normalised.theme_primary_color, "#000000");
  const ok = checkSettingsWrite({ maintenance_mode: "none" }, { enabledExtensions: [], allowProtected: true });
  assert.equal(ok.issues.length, 0);
});

// ---------------------------------------------------------------- images

test("key policy matches the database's case-, space- and accent-insensitive comparison", () => {
  for (const k of ["Extensions_Enabled", "EXTENSIONS_ENABLED", "Logo_Path", "Custom_Less_Error", "extensions_enabled ", "extensíons_enabled", "a/b"]) {
    assert.equal(classifyKey(k), "forbidden", k);
  }
  for (const k of ["MAINTENANCE_MODE", "Mail_Host", "Allow_Sign_Up", "Default_Locale"]) assert.equal(classifyKey(k), "protected", k);
  assert.equal(classifyKey("Custom_Less"), "forbidden", "design keys only in their exact spelling");
  assert.equal(classifyKey("custom_less"), "theme");
  assert.equal(classifyKey("Welcome_Title"), "forbidden");
  assert.equal(classifyKey("fof-upload.mimeTypes", ["fof-upload"]), "extension");
  const r = checkSettingsWrite({ Extensions_Enabled: "[]", MAINTENANCE_MODE: "high" }, { enabledExtensions: [] });
  assert.equal(r.issues.filter((i) => i.level === "error").length, 2);
  assert.deepEqual(Object.keys(r.normalised), []);
});

test("HTML settings warn about every way to run code; icon CDNs warn about privacy; dsn/webhook keys are secret", () => {
  const msg = (k, v) => validateValue(k, v).map((i) => i.message).join(" | ");
  assert.match(msg("custom_footer", '<img src=x onerror="steal()">'), /inline event handler/);
  assert.match(msg("custom_header", '<a href="javascript:alert(1)">x</a>'), /javascript: URL/);
  assert.match(msg("custom_header", "<script>x()</script>"), /<script>/);
  assert.equal(validateValue("custom_footer", "<p>plain <b>html</b></p>").length, 0);
  assert.match(msg("fontawesome_cdn_url", "https://cdn.example/fa.css"), /privacy/);
  assert.equal(classifyKey("sentry.dsn"), "protected");
  assert.equal(classifyKey("fof-webhooks.webhook_url"), "protected");
});

test("another spelling of a design key cannot skip the value checks", () => {
  const r = checkSettingsWrite({ Custom_Less: "@import 'x.less'; .a{ data-uri('/etc/passwd') }", Theme_Primary_Color: "red; @import (inline) '/etc/passwd'" }, { enabledExtensions: [] });
  assert.equal(r.issues.filter((i) => i.level === "error").length, 2);
  assert.ok(r.issues.every((i) => /write it as "(custom_less|theme_primary_color)"/.test(i.message)));
  assert.deepEqual(Object.keys(r.normalised), []);
  // camelCase extension keys stay allowed
  assert.equal(checkSettingsWrite({ "fof-upload.mimeTypes": "x" }, { enabledExtensions: ["fof-upload"] }).issues.length, 0);
});

test("sniffImage reads type and dimensions from magic bytes, not the extension", () => {
  assert.deepEqual(sniffImage(pngBytes(300, 90)), { mime: "image/png", ext: "png", width: 300, height: 90 });
  const gif = Buffer.from("GIF89a\x40\x00\x20\x00", "latin1");
  assert.equal(sniffImage(gif).mime, "image/gif");
  assert.equal(sniffImage(gif).width, 64);
  assert.equal(sniffImage(Buffer.from("not an image at all")), undefined);
});

test("checkUpload rejects SVG, oversized files and huge images before any request", () => {
  assert.throws(() => checkUpload(Buffer.from('<?xml version="1.0"?><svg></svg>'), "logo.svg"), /SVG/);
  assert.throws(() => checkUpload(Buffer.alloc(2048 * 1024 + 1), "big.png"), /2048 KB/);
  assert.throws(() => checkUpload(pngBytes(6000, 5000), "huge.png"), /MP/);
  assert.equal(checkUpload(pngBytes(), "ok.png").info.mime, "image/png");
});

// ----------------------------------------------------- mock forum fixtures

let mock;
let root;
const cfgFor = (forumRoot) => ({
  name: "test",
  baseUrl: mock.base,
  forumRoot,
  tokenFile: "/nonexistent",
  designSetsDir: join(forumRoot, "sets"),
  publicAssetsSubdir: "design-sets",
  services: [],
  repoRoot: forumRoot,
  source: "test",
});
const opsWith = (token = ADMIN_TOKEN) =>
  new Ops(cfgFor(root), new FlarumClient({ baseUrl: mock.base, apiKey: token }), mock.settingsStore);

before(async () => {
  root = makeForumRoot();
  mock = await startMockFlarum({ forumRoot: root });
});
after(async () => {
  await mock.close();
});

// ---------------------------------------------------------------- client

test("raw() reports status codes, including 204 with an empty body", async () => {
  const c = new FlarumClient({ baseUrl: mock.base, apiKey: ADMIN_TOKEN });
  const res = await c.raw({ method: "POST", path: "/api/settings", body: { forum_title: "Renamed" } });
  assert.equal(res.status, 204);
  assert.equal(res.ok, true);
  assert.equal(res.body, null);
  assert.equal(mock.store.get("forum_title"), "Renamed");
});

test("upload() sends multipart with the route name as the field name", async () => {
  const c = new FlarumClient({ baseUrl: mock.base, apiKey: ADMIN_TOKEN });
  const res = await c.upload({ path: "/logo-dark-mode", field: "logo-dark-mode", filename: "x.png", data: pngBytes(), mimeType: "image/png" });
  assert.equal(res.status, 200);
  const last = mock.requests.at(-1);
  assert.match(last.contentType, /^multipart\/form-data/);
  assert.match(mock.store.get("logo_dark_mode_path"), /^logo-dark-mode-/);
});

test("read-only client refuses uploads before any network call", async () => {
  const c = new FlarumClient({ baseUrl: mock.base, apiKey: ADMIN_TOKEN, readOnly: true });
  const n = mock.requests.length;
  await assert.rejects(() => c.upload({ path: "/logo", field: "logo", filename: "x.png", data: pngBytes(), mimeType: "image/png" }), /read-only/);
  assert.equal(mock.requests.length, n);
});

test("per-call timeouts abort with a message that warns the write may have completed", async () => {
  const c = new FlarumClient({ baseUrl: "http://10.255.255.1", apiKey: ADMIN_TOKEN });
  await assert.rejects(() => c.raw({ method: "POST", path: "/settings", body: {}, timeoutMs: 50 }), /timed out after 50 ms[\s\S]*may still have completed/);
});

// ------------------------------------------------------------------ auth

test("whoami detects a rejected token (Flarum silently treats it as a guest)", async () => {
  const bad = new FlarumClient({ baseUrl: mock.base, apiKey: "wrong-token-xyz" });
  const { actor } = await whoami(bad);
  assert.equal(actor.authenticated, false);
  await assert.rejects(() => requireAdmin(bad), /guest/);
});

test("whoami resolves admin vs member through the user's groups", async () => {
  assert.equal((await whoami(new FlarumClient({ baseUrl: mock.base, apiKey: ADMIN_TOKEN }))).actor.isAdmin, true);
  const member = new FlarumClient({ baseUrl: mock.base, apiKey: MEMBER_TOKEN });
  assert.equal((await whoami(member)).actor.isAdmin, false);
  await assert.rejects(() => requireAdmin(member), /not an admin/);
});

// ------------------------------------------------------------------- ops

test("settingsSet without confirm is a dry run: nothing is sent", async () => {
  const ops = opsWith();
  const n = mock.requests.filter((r) => r.method === "POST").length;
  const res = await ops.settingsSet({ theme_primary_color: "#112233" });
  assert.equal(res.dryRun, true);
  assert.equal(mock.requests.filter((r) => r.method === "POST").length, n);
  assert.deepEqual(res.wouldSend, [{ key: "theme_primary_color", from: "#4D698E", to: "#112233" }]);
});

test("settingsSet sends custom_less alone first, then the rest, and verifies by read-back", async () => {
  const ops = opsWith();
  const start = mock.requests.length;
  const res = await ops.settingsSet({ custom_less: ".a{color:red}", theme_secondary_color: "#223344" }, { confirm: true });
  const posts = mock.requests.slice(start).filter((r) => r.method === "POST" && r.path === "/api/settings");
  assert.equal(posts.length, 2);
  assert.deepEqual(Object.keys(JSON.parse(posts[0].body)), ["custom_less"]);
  assert.deepEqual(Object.keys(JSON.parse(posts[1].body)), ["theme_secondary_color"]);
  assert.equal(res.verify.ok, true);
});

test("a rejected custom_less (422) restores the previous value, clearing custom_less_error", async () => {
  const ops = opsWith();
  mock.store.set("custom_less", ".keep{color:blue}");
  await assert.rejects(
    () => ops.settingsSet({ custom_less: ".a{BROKEN}", forum_title: "Never" }, { confirm: true }),
    (err) => err instanceof OpsError && /rejected \(422\)/.test(err.message) && /Nothing else was changed/.test(err.message),
  );
  assert.equal(mock.store.get("custom_less"), ".keep{color:blue}");
  assert.equal(mock.store.has("custom_less_error"), false);
  assert.notEqual(mock.store.get("forum_title"), "Never");
});

test("remote mode: a rejected custom_less is not 'restored' to an empty string (the previous value is unknown)", async () => {
  const remote = new Ops({ ...cfgFor(root), forumRoot: undefined }, new FlarumClient({ baseUrl: mock.base, apiKey: ADMIN_TOKEN }));
  assert.equal(remote.local, false);
  mock.store.set("custom_less", ".keep{color:blue}");
  const start = mock.requests.length;
  await assert.rejects(
    () => remote.settingsSet({ custom_less: ".a{BROKEN}" }, { confirm: true }),
    (err) => err instanceof OpsError && /rejected \(422\)/.test(err.message) && /custom_less_error/.test(err.message),
  );
  const posts = mock.requests.slice(start).filter((r) => r.method === "POST" && r.path === "/api/settings");
  assert.equal(posts.length, 1, "only the rejected write, no blind restore");
  assert.equal(mock.store.get("custom_less"), ".keep{color:blue}");
  mock.store.delete("custom_less_error");
});

test("when re-saving the previous custom_less also fails, the error says the flag stays set", async () => {
  const ops = opsWith();
  mock.store.set("custom_less", ".keep{color:blue}");
  const realRaw = ops.client.raw.bind(ops.client);
  let posts = 0;
  ops.client.raw = async (req) => {
    if (req.method === "POST" && req.path === "/settings" && ++posts === 2) return { status: 500, ok: false, contentType: "", body: null };
    return realRaw(req);
  };
  await assert.rejects(
    () => ops.settingsSet({ custom_less: ".a{BROKEN}" }, { confirm: true }),
    (err) => /Re-saving the previous custom_less FAILED \(500\)/.test(err.message),
  );
  mock.store.delete("custom_less_error");
});

test("settingsSet blocks forbidden keys even with confirm", async () => {
  const res = await opsWith().settingsSet({ extensions_enabled: "[]" }, { confirm: true });
  assert.equal(res.dryRun, true);
  assert.equal(res.blocked, true);
});

test("settingsReset deletes keys and clears the cache for CSS keys (no auto rebuild after DELETE)", async () => {
  const ops = opsWith();
  mock.store.set("custom_less", ".x{}");
  const start = mock.requests.length;
  const res = await ops.settingsReset(["custom_less"], { confirm: true });
  const calls = mock.requests.slice(start).map((r) => `${r.method} ${r.path}`);
  assert.ok(calls.includes("DELETE /api/settings"));
  assert.ok(calls.includes("DELETE /api/cache"));
  assert.equal(mock.store.has("custom_less"), false);
  assert.equal(res.steps.at(-1).ok, true);
});

test("settingsReset applies the key policy: managed keys never, protected keys only with allowProtected", async () => {
  const ops = opsWith();
  mock.store.set("mail_password", "smtp-secret");
  mock.store.set("maintenance_mode", "none");
  const n = mock.requests.filter((r) => r.method === "DELETE").length;
  for (const k of ["logo_path", "Extensions_Enabled", "custom_less_error", "assets_dirty.forum"]) {
    const r = await ops.settingsReset([k], { confirm: true });
    assert.equal(r.dryRun, true, k);
    assert.deepEqual(r.blocked, [k]);
  }
  const p = await ops.settingsReset(["mail_password"], { confirm: true });
  assert.deepEqual(p.blocked, ["mail_password"]);
  assert.ok(p.issues.some((i) => i.level === "warning" && /cannot be undone/.test(i.message)));
  assert.equal(mock.requests.filter((r) => r.method === "DELETE").length, n, "nothing deleted");
  const ok = await ops.settingsReset(["maintenance_mode"], { confirm: true, allowProtected: true });
  assert.equal(ok.dryRun, false);
  assert.equal(mock.store.has("maintenance_mode"), false);
});

test("a write whose read-back does not match fails (CLI exit 1 / MCP isError), it is not reported as success", async () => {
  const stale = {
    ...mock.settingsStore,
    async read(keys, prefixes) {
      const out = await mock.settingsStore.read(keys, prefixes);
      if ("forum_title" in out) out.forum_title = { state: "value", value: "stale" };
      return out;
    },
  };
  const ops = new Ops(cfgFor(root), new FlarumClient({ baseUrl: mock.base, apiKey: ADMIN_TOKEN }), stale);
  await assert.rejects(
    () => ops.settingsSet({ forum_title: "New" }, { confirm: true }),
    (err) => err instanceof OpsError && /read-back does not match/.test(err.message) && err.steps.at(-1).step === "verify",
  );
});

test("a failed cache clear after a settings write or reset is an error", async () => {
  const ops = opsWith();
  mock.behaviour.cacheFails = true;
  try {
    await assert.rejects(() => ops.settingsReset(["custom_less"], { confirm: true }), /cache clear failed/);
  } finally {
    mock.behaviour.cacheFails = false;
  }
});

test("cacheClear parses NDJSON and fails when a step failed or the stream ended without done", async () => {
  const ops = opsWith();
  assert.equal((await ops.cacheClear({ confirm: true })).steps[0].ok, true);
  try {
    mock.behaviour.cacheFails = true;
    await assert.rejects(() => ops.cacheClear({ confirm: true }), /failure/);
    mock.behaviour.cacheFails = false;
    mock.behaviour.cacheDropped = true; // PHP timeout / fatal mid-rebuild: 200, but no final "done"
    await assert.rejects(() => ops.cacheClear({ confirm: true }), (e) => /failure/.test(e.message) && /without the final done/.test(JSON.stringify(e.steps)));
  } finally {
    mock.behaviour.cacheFails = false;
    mock.behaviour.cacheDropped = false;
  }
});

test("uploadImage dry-runs, then uploads and returns the new URL", async () => {
  const ops = opsWith();
  const file = join(root, "logo-src.png");
  writeFileSync(file, pngBytes(400, 100));
  const dry = await ops.uploadImage("logo", file);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.wouldUpload.field, "logo");
  const res = await ops.uploadImage("logo", file, { confirm: true });
  assert.match(String(res.url), /\/assets\/logo-[0-9a-f]+\.webp$/);
});

test("uploading a dark-mode logo without a normal logo warns that it will not be shown", async () => {
  const ops = opsWith();
  mock.store.delete("logo_path");
  const file = join(root, "dark-src.png");
  writeFileSync(file, pngBytes(300, 120));
  const dry = await ops.uploadImage("logo_dark_mode", file);
  assert.ok(dry.advice.some((a) => /only shows the dark-mode logo when a normal logo exists/.test(a)));
});

test("extensionSet warns about migrations in the dry run and toggles with confirm", async () => {
  const ops = opsWith();
  const dry = await ops.extensionSet("flarum-gdpr", true);
  assert.equal(dry.dryRun, true);
  assert.match(dry.warning, /migrations/);
  const res = await ops.extensionSet("flarum-gdpr", true, { confirm: true });
  assert.ok(JSON.parse(mock.store.get("extensions_enabled")).includes("flarum-gdpr"));
  assert.equal(res.verify.ok, true);
  await assert.rejects(() => ops.extensionSet("../etc", true), /not an extension id/);
});

test("permissionSet shows the current groups before replacing them", async () => {
  const ops = opsWith();
  const dry = await ops.permissionSet("startDiscussion", [3, 4]);
  assert.deepEqual(dry.currentGroupIds, [3]);
  const res = await ops.permissionSet("startDiscussion", [3, 4], { confirm: true });
  assert.deepEqual(res.previousGroupIds, [3]);
  assert.deepEqual(mock.permissions.startDiscussion, [3, 4]);
});

test("health checks root, API and every stylesheet", async () => {
  const h = await opsWith().health();
  assert.equal(h.ok, true, JSON.stringify(h.problems));
  assert.equal(h.root, 200);
  assert.deepEqual(Object.values(h.stylesheets), [200]);
});

test("health sends the client's User-Agent (WAFs 403 generic UAs) and times out instead of hanging", async () => {
  const ua = "flarum2-ops-test/1.0";
  const ops = new Ops(cfgFor(root), new FlarumClient({ baseUrl: mock.base, apiKey: ADMIN_TOKEN, userAgent: ua }), mock.settingsStore);
  mock.behaviour.requireUserAgent = ua;
  try {
    const h = await ops.health();
    assert.equal(h.root, 200, JSON.stringify(h.problems));
  } finally {
    mock.behaviour.requireUserAgent = null;
  }
  mock.behaviour.hangRoot = true;
  try {
    const t0 = Date.now();
    const h = await ops.health(undefined, { timeoutMs: 200 });
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(h.ok, false);
    assert.equal(h.root, 0);
  } finally {
    mock.behaviour.hangRoot = false;
  }
});

test("health judges only the forum's own stylesheets and never fetches third-party CSS", async () => {
  mock.behaviour.extraStylesheets = ["//fonts.example.invalid/css?family=X", "https://cdn.example.invalid/w.css"];
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    fetched.push(String(url));
    return realFetch(url, init);
  };
  try {
    const h = await opsWith().health();
    assert.equal(h.ok, true, JSON.stringify(h.problems));
    assert.deepEqual(h.externalStylesheets, mock.behaviour.extraStylesheets);
    assert.equal(fetched.some((u) => /example\.invalid/.test(u)), false);
  } finally {
    globalThis.fetch = realFetch;
    mock.behaviour.extraStylesheets = [];
  }
});

test("a host without systemctl is a health warning, not a problem that rolls an apply back", async () => {
  const ops = new Ops({ ...cfgFor(root), services: ["nginx"] }, new FlarumClient({ baseUrl: mock.base, apiKey: ADMIN_TOKEN }), mock.settingsStore);
  const savedPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const h = await ops.health();
    assert.equal(h.ok, true, JSON.stringify(h.problems));
    assert.ok(h.warnings.some((w) => /no systemctl/.test(w)));
  } finally {
    process.env.PATH = savedPath;
  }
});

test("login sends the identifiable User-Agent, stores the token 0600 and never includes the password in errors", async () => {
  const { statSync, readFileSync } = await import("node:fs");
  const file = join(root, "tok", "token");
  const res = await loginAndStore(mock.base, "admin", "correct-password", file, "flarum2-ops-test/9.9");
  assert.equal(res.userId, "1");
  assert.equal(mock.requests.findLast((r) => r.path === "/api/token").userAgent, "flarum2-ops-test/9.9");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file, "utf8").trim(), ADMIN_TOKEN);
  await assert.rejects(() => loginAndStore(mock.base, "admin", "wrong-pw-xyz", file, "ua"), (e) => /Login failed/.test(e.message) && !e.message.includes("wrong-pw-xyz"));
});

test("insecureLoginWarning flags plain http to a remote host only", () => {
  assert.match(insecureLoginWarning("http://forum.example.org"), /plain http/);
  assert.match(insecureLoginWarning("http://10.0.0.5:8080"), /plain http/);
  for (const ok of ["https://forum.example.org", "http://localhost:8080", "http://127.0.0.1", "http://[::1]:8080"]) {
    assert.equal(insecureLoginWarning(ok), undefined, ok);
  }
});

test("image writes warn when the previous image cannot be restored, and never promise a rollback for it", async () => {
  const ico = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0]);
  writeFileSync(join(root, "public", "assets", "favicon-old.ico"), ico);
  mock.store.set("favicon_path", "favicon-old.ico");
  const file = join(root, "fav.png");
  writeFileSync(file, pngBytes(64, 64));
  const ops = opsWith();
  const dry = await ops.uploadImage("favicon", file);
  assert.ok(dry.advice.some((a) => /cannot be restored afterwards/.test(a)));
  const res = await ops.uploadImage("favicon", file, { confirm: true });
  assert.equal(res.rollback, null);
  assert.match(res.rollbackNote, /not restorable/);
  mock.store.set("favicon_path", "on-a-remote-disk.png");
  assert.match((await ops.deleteImage("favicon")).warning, /not on the local assets disk/);
});

test("uploadImage refuses non-regular and oversized files before reading them", async () => {
  const { execFileSync } = await import("node:child_process");
  const fifo = join(root, "pipe.png");
  execFileSync("mkfifo", [fifo]);
  await assert.rejects(() => opsWith().uploadImage("logo", fifo), /not a regular file/);
  const big = join(root, "big.png");
  writeFileSync(big, Buffer.alloc(3 * 1024 * 1024));
  await assert.rejects(() => opsWith().uploadImage("logo", big), /at most 2048 KB/);
});

test("settings set warns that a secret cannot be restored by rollback", async () => {
  const dry = await opsWith().settingsSet({ mail_password: "x" }, { allowProtected: true });
  assert.ok(dry.issues.some((i) => i.key === "mail_password" && i.level === "warning" && /cannot restore/.test(i.message)));
});

test("active-HTML warnings catch the usual bypass spellings; the kit URL must be Font Awesome's", async () => {
  const { activeHtml } = await import("../dist/policy.js");
  for (const v of ["<svg/onload=alert(1)>", "<img/src=x/onerror=alert(1)>", "<iframe src=//evil.example>", '<a href="&#106;avascript:x">', '<meta http-equiv="refresh" content="0;url=//evil">', '<link rel=stylesheet href="//evil.example/x.css">', "<form action=//evil>"]) {
    assert.ok(activeHtml(v).length > 0, v);
  }
  assert.deepEqual(activeHtml('<p class="note"><a href="/t/news">News</a> <img src="/assets/x.png" alt=""></p>'), []);
  assert.equal(validateValue("fontawesome_kit_url", "https://evil.example/x.js")[0].level, "error");
  assert.equal(validateValue("fontawesome_kit_url", "https://kit.fontawesome.com/abc123.js")[0].level, "warning");
  assert.ok(lintLess('@import"https://x.example/a.css";').length > 0);
  assert.ok(lintLess("@impor '/etc/passwd';").some((i) => i.level === "error"));
});

test("secret detection covers common credential spellings, also camelCase", () => {
  for (const k of ["fof-upload.awsS3Key", "fof-upload.awsS3KeyId", "acme.smtp_pwd", "acme.jwt_signing", "acme.access_key_id", "acme.bearer", "sentry.dsn", "acme.salt"]) {
    assert.equal(isSecretKey(k), true, k);
  }
  for (const k of ["theme_primary_color", "fof-upload.mimeTypes", "flarum-tags.max_primary_tags", "custom_less"]) assert.equal(isSecretKey(k), false, k);
});

test("FLARUM_USER_ID must be numeric", () => {
  assert.throws(() => new FlarumClient({ baseUrl: "http://forum.test", apiKey: "abcdef123456", userId: "1\r\nX: y" }), /numeric user id/);
  new FlarumClient({ baseUrl: "http://forum.test", apiKey: "abcdef123456", userId: "1" });
});

test("setting a CSS key to NULL clears the cache (Flarum only rebuilds CSS for keys saved with a value)", async () => {
  const ops = opsWith();
  const start = mock.requests.length;
  await ops.settingsSet({ custom_less: null }, { confirm: true });
  assert.ok(mock.requests.slice(start).some((r) => r.method === "DELETE" && r.path === "/api/cache"));
  const { writeNeedsCacheClear } = await import("../dist/policy.js");
  assert.equal(writeNeedsCacheClear({ custom_less: ".a{}" }), false);
  assert.equal(writeNeedsCacheClear({ fontawesome_source: "local" }), true);
});

test("SVG/HTML script checks catch namespaced script and tab-split javascript:; /token and /sessions are refused", async () => {
  const { activeHtml, managedWrite } = await import("../dist/policy.js");
  assert.ok(activeHtml('<x:script xmlns:x="http://www.w3.org/2000/svg">steal()</x:script>').length > 0);
  assert.ok(activeHtml('<a xlink:href="java\tscript:steal()">x</a>').length > 0);
  assert.ok(managedWrite("/token"));
  assert.ok(managedWrite("/sessions"));
});

test("log lines handed to the agent mask e-mail addresses, IPs and the credential", async () => {
  const { maskPersonalData } = await import("../dist/ops.js");
  const line = "flarum.ERROR: mail to jane.doe@example.org from 203.0.113.7 / 2001:db8::1 failed, token abcdef123456";
  const out = maskPersonalData(line, "abcdef123456");
  assert.equal(/jane|203\.0\.113|2001:db8|abcdef123456/.test(out), false, out);
  assert.match(out, /<email>.*<ip>/);
  assert.equal(maskPersonalData("[2026-11-24T10:00:00+00:00] flarum.ERROR: x"), "[2026-11-24T10:00:00+00:00] flarum.ERROR: x", "timestamps stay");
});

test("header/footer HTML that loads from another host is a privacy warning naming the host", async () => {
  const { validateValue } = await import("../dist/policy.js");
  const issues = validateValue("custom_footer", '<p>Hi</p><img src="https://tracker.test/p.gif"><div style="background:url(//cdn.test/x.png)"></div>');
  const w = issues.find((i) => /loads resources from/.test(i.message));
  assert.ok(w, JSON.stringify(issues));
  assert.match(w.message, /tracker\.test/);
  assert.match(w.message, /cdn\.test/);
  assert.equal(validateValue("custom_footer", '<img src="/assets/design-sets/x/1/a.png">').some((i) => /loads resources/.test(i.message)), false);
});
