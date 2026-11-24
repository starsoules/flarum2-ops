// Tests that close gaps found by mutation checks: each one fails when the named safeguard in dist/ is disabled.
// The comment above a test names the mutation it kills.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlarumClient } from "../dist/flarum-client.js";
import { Ops, OpsError } from "../dist/ops.js";
import { DesignSets } from "../dist/designset.js";
import { startMockFlarum, makeForumRoot, ADMIN_TOKEN, MEMBER_TOKEN, pngBytes } from "./helpers/mock-flarum.mjs";

let mock;
let root;

beforeEach(async () => {
  root = makeForumRoot();
  mock = await startMockFlarum({
    forumRoot: root,
    settings: { welcome_title: "Welcome!" },
  });
});
afterEach(async () => {
  await mock.close();
});

const cfg = (extra = {}) => ({
  name: "test",
  baseUrl: mock.base,
  forumRoot: root,
  tokenFile: "/nonexistent",
  designSetsDir: join(root, "design-sets"),
  publicAssetsSubdir: "design-sets",
  services: [],
  repoRoot: root,
  source: "test",
  ...extra,
});
const opsWith = (token = ADMIN_TOKEN, extra = {}) =>
  new Ops(cfg(extra), new FlarumClient({ baseUrl: mock.base, apiKey: token }), mock.settingsStore);

const calls = (from = 0) => mock.requests.slice(from).map((r) => `${r.method} ${r.path}`);

// ------------------------------------------------- read-back after a confirmed write
// A server that answers 2xx and silently does not apply the write must make the operation fail, not succeed.

// Mutation: ops.ts settingsReset, `requireVerified(verify, steps, "settings reset")` removed.
test("settingsReset fails when the server accepts the DELETE but keeps the key", async () => {
  mock.behaviour.ignoreDeleteKey = "welcome_title";
  await assert.rejects(
    () => opsWith().settingsReset(["welcome_title"], { confirm: true }),
    (err) =>
      err instanceof OpsError &&
      /settings reset was sent, but the read-back does not match/.test(err.message) &&
      err.steps.at(-1).step === "verify" &&
      err.steps.at(-1).ok === false,
  );
  assert.equal(mock.store.get("welcome_title"), "Welcome!", "the mock really kept it");
});

// Mutation: ops.ts uploadImage, `requireVerified(verify, steps, `${kind} upload`)` removed.
test("uploadImage fails when the server answers 200 but stores no image path", async () => {
  mock.behaviour.ignoreUpload = true;
  const file = join(root, "logo-src.png");
  writeFileSync(file, pngBytes(400, 100));
  await assert.rejects(
    () => opsWith().uploadImage("logo", file, { confirm: true }),
    (err) => err instanceof OpsError && /logo upload was sent, but the read-back does not match/.test(err.message) && err.steps.at(-1).step === "verify",
  );
  assert.equal(mock.store.get("logo_path"), undefined, "the mock really stored nothing");
  assert.ok(calls().includes("POST /api/logo"), "the upload was attempted");
});

// Mutation: ops.ts extensionToggle (extensionSet), `requireVerified(verify, steps, ...)` removed.
test("extensionSet fails when the server ignores the toggle", async () => {
  mock.behaviour.ignoreExtensionToggle = true;
  await assert.rejects(
    () => opsWith().extensionSet("flarum-gdpr", true, { confirm: true }),
    (err) => err instanceof OpsError && /enable flarum-gdpr was sent, but the read-back does not match/.test(err.message) && err.steps.at(-1).step === "verify",
  );
  assert.equal(JSON.parse(mock.store.get("extensions_enabled")).includes("flarum-gdpr"), false);
  assert.ok(calls().includes("PATCH /api/extensions/flarum-gdpr"));
});

// Mutation: ops.ts permissionSet, `requireVerified(verify, steps, `permission ${permission}`, ...)` removed.
test("permissionSet fails when the server ignores the POST, and names how to restore", async () => {
  mock.behaviour.ignorePermission = true;
  await assert.rejects(
    () => opsWith().permissionSet("startDiscussion", [3, 4], { confirm: true }),
    (err) =>
      err instanceof OpsError &&
      /permission startDiscussion was sent, but the read-back does not match/.test(err.message) &&
      /Previous groups restore with: permission startDiscussion 3/.test(err.message),
  );
  assert.deepEqual(mock.permissions.startDiscussion, [3], "the mock really kept the old groups");
  assert.ok(calls().includes("POST /api/permission"));
});

// ------------------------------------------------------------- cache clear for icon keys

// Mutation: ops.ts settingsSet, the `NEEDS_CACHE_CLEAR_KEYS` cache-clear step skipped.
test("settingsSet of fontawesome_source clears the cache afterwards (Flarum does not rebuild by itself)", async () => {
  const start = mock.requests.length;
  const res = await opsWith().settingsSet({ fontawesome_source: "local" }, { confirm: true });
  const seen = calls(start).filter((c) => c !== "GET /" && !c.startsWith("GET /api"));
  assert.deepEqual(seen, ["POST /api/settings", "DELETE /api/cache"]);
  assert.equal(res.steps.at(-1).step, "cache clear");
  assert.equal(res.steps.at(-1).ok, true);
  assert.equal(mock.store.get("fontawesome_source"), "local");

  // Contrast: a key that does not need it sends no cache request.
  const before = mock.requests.length;
  await opsWith().settingsSet({ forum_title: "Renamed" }, { confirm: true });
  assert.equal(calls(before).includes("DELETE /api/cache"), false);
});

// ------------------------------------------------------------------------------ health

const today = () => new Date().toISOString().slice(0, 10);
const logFile = () => join(root, "storage", "logs", `flarum-${today()}.log`);

/** A fake `systemctl` that reports every unit as failed (exit 3, like a stopped service). */
function fakeSystemctl() {
  const dir = mkdtempSync(join(tmpdir(), "flarum2-ops-systemctl-"));
  const bin = join(dir, "systemctl");
  writeFileSync(bin, "#!/bin/sh\necho failed\nexit 3\n");
  chmodSync(bin, 0o755);
  return dir;
}

test("health baseline: a healthy mock forum with a log directory is ok (so the faults below are the cause)", async () => {
  mkdirSync(join(root, "storage", "logs"), { recursive: true });
  writeFileSync(logFile(), "[2020-01-01T00:00:00+00:00] flarum.INFO: all fine\n");
  const h = await opsWith().health();
  assert.equal(h.ok, true, JSON.stringify(h.problems));
  assert.deepEqual(h.problems, []);
  assert.deepEqual(h.logErrors, []);
});

// Mutation: ops.ts health, `if (root.status !== 200) problems.push(...)` removed.
test("health: a forum root that answers 500 is a problem", async () => {
  mock.behaviour.rootStatus = 500;
  const h = await opsWith().health();
  assert.equal(h.ok, false);
  assert.equal(h.root, 500);
  assert.ok(h.problems.some((p) => /forum root returned 500/.test(p)), JSON.stringify(h.problems));
});

// Mutation: ops.ts health, `if (api.status !== 200) problems.push(...)` removed.
test("health: an API root that answers 500 is a problem", async () => {
  mock.behaviour.apiStatus = 500;
  const h = await opsWith().health();
  assert.equal(h.ok, false);
  assert.equal(h.root, 200);
  assert.equal(h.api, 500);
  assert.ok(h.problems.some((p) => /API root returned 500/.test(p)), JSON.stringify(h.problems));
});

// Mutation: ops.ts health, `if (r.status !== 200) problems.push(`stylesheet ...`)` removed.
test("health: one of the forum's own stylesheets answering 404 is a problem", async () => {
  mock.behaviour.extraStylesheets = ["/assets/missing.css"];
  const h = await opsWith().health();
  assert.equal(h.ok, false);
  assert.equal(h.stylesheets["/assets/missing.css"], 404);
  assert.ok(h.problems.some((p) => /stylesheet \/assets\/missing\.css returned 404/.test(p)), JSON.stringify(h.problems));
});

// Mutation: ops.ts health, `else if (st !== "active") problems.push(`service ${s} is ${st}`)` removed.
test("health: a service that systemctl reports as failed (exit 3) is a problem", async () => {
  const saved = process.env.PATH;
  process.env.PATH = fakeSystemctl();
  try {
    const h = await opsWith(ADMIN_TOKEN, { services: ["nginx"] }).health();
    assert.equal(h.ok, false);
    assert.deepEqual(h.services, { nginx: "failed" });
    assert.ok(h.problems.some((p) => /service nginx is failed/.test(p)), JSON.stringify(h.problems));
  } finally {
    process.env.PATH = saved;
  }
});

// Mutation: ops.ts health, `if (logs.errors.length) problems.push(...)` removed.
test("health: a new ERROR line in today's storage/logs file is reported as a warning (not a problem); an old one not at all", async () => {
  mkdirSync(join(root, "storage", "logs"), { recursive: true });
  const now = new Date();
  const stamp = now.toISOString().slice(0, 19) + "+00:00";
  const old = new Date(now.getTime() - 3 * 3600_000).toISOString().slice(0, 19) + "+00:00";
  writeFileSync(logFile(), `[${old}] flarum.ERROR: stale failure from hours ago\n[${stamp}] flarum.ERROR: Class \"Foo\" not found\n`);
  utimesSync(logFile(), now, now);
  const since = new Date(now.getTime() - 60_000);
  const h = await opsWith().health(since);
  assert.equal(h.ok, true, "log errors never fail health (they would roll a correct apply back)");
  assert.equal(h.logErrors.length, 1, JSON.stringify(h.logErrors));
  assert.match(h.logErrors[0].line, /Class "Foo" not found/);
  assert.ok(h.warnings.some((p) => /1 error line\(s\) in storage\/logs since/.test(p)), JSON.stringify(h.warnings));
});

// Mutation: ops.ts health, `problems.push("custom_less_error is set: ...")` removed.
test("health: a custom_less_error left in the settings is a problem", async () => {
  mock.store.set("custom_less_error", "ParseError: unrecognised input");
  const h = await opsWith().health();
  assert.equal(h.ok, false);
  assert.equal(h.customLessError, "ParseError: unrecognised input");
  assert.ok(h.problems.some((p) => /custom_less_error is set/.test(p)), JSON.stringify(h.problems));
});

// ------------------------------------------------------------------- design-set paths

function setsWith(ops) {
  return new DesignSets(ops);
}

function writeSet(name, spec, files = {}) {
  const dir = join(root, "design-sets", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "set.json"), JSON.stringify({ name, title: name, ...spec }, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

// Mutation: designset.ts insideSet, `p.startsWith(root + sep)` weakened to `p.startsWith(root)`.
test("a set cannot read a file from a sibling folder whose name starts with its own (brand vs brand-dark)", async () => {
  writeSet("brand", { less: "../brand-dark/x.less" });
  writeSet("brand-dark", {}, { "x.less": ".sibling-secret{color:red}" });
  const sets = setsWith(opsWith());
  const plan = await sets.plan("brand");
  assert.equal(plan.blocked, true, JSON.stringify(plan.issues));
  assert.ok(plan.issues.some((i) => i.key === "custom_less" && i.level === "error" && /not found inside the set/.test(i.message)), JSON.stringify(plan.issues));
  assert.ok(!JSON.stringify(plan).includes("sibling-secret"), "the sibling's content is not even planned");

  const n = mock.requests.filter((r) => r.method !== "GET").length;
  const res = await sets.apply("brand", { confirm: true });
  assert.equal(res.dryRun, true, "a blocked plan is never applied");
  assert.equal(mock.requests.filter((r) => r.method !== "GET").length, n);
  assert.ok(!String(mock.store.get("custom_less")).includes("sibling-secret"));
});

// Mutation: designset.ts pruneStatic, the `/^[0-9a-f]{8}$/` check on version folder names removed.
test("apply prunes stale version folders but leaves a foreign folder (notes) under the set's static directory alone", async () => {
  const sets = setsWith(opsWith());
  writeSet("keeper", { settings: { theme_primary_color: "#334155" } }, { "static/fonts/x.woff2": "DATA" });
  const base = join(root, "public", "assets", "design-sets", "keeper");
  mkdirSync(join(base, "notes"), { recursive: true });
  writeFileSync(join(base, "notes", "readme.txt"), "my own notes");
  mkdirSync(join(base, "deadbeef"), { recursive: true });
  writeFileSync(join(base, "deadbeef", "old.txt"), "stale version");

  const res = await sets.apply("keeper", { confirm: true });
  assert.equal(res.dryRun, false, JSON.stringify(res));
  assert.equal(existsSync(join(base, "deadbeef")), false, "a stale 8-hex version folder is pruned (prune really ran)");
  assert.equal(readFileSync(join(base, "notes", "readme.txt"), "utf8"), "my own notes", "a folder that is not a version stays");
  const kept = readdirSync(base).filter((d) => /^[0-9a-f]{8}$/.test(d));
  assert.equal(kept.length, 1, "the live version is kept");
  assert.ok(existsSync(join(base, kept[0], "fonts", "x.woff2")));
});

// ------------------------------------------------------------------------ admin check

// Mutation: ops.ts settingsSet, `await requireAdmin(this.client)` removed.
test("settingsSet with a member token and confirm is refused as 'not an admin' before any write", async () => {
  const before = mock.requests.length;
  await assert.rejects(() => opsWith(MEMBER_TOKEN).settingsSet({ theme_primary_color: "#111111" }, { confirm: true }), /not an admin/);
  const writes = mock.requests.slice(before).filter((r) => r.method !== "GET");
  assert.deepEqual(writes, [], "no POST/PATCH/DELETE left the client");
  assert.equal(mock.store.get("theme_primary_color"), "#4D698E");
});
