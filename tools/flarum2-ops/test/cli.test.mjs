import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startMockFlarum, makeForumRoot, ADMIN_TOKEN } from "./helpers/mock-flarum.mjs";
import { cleanEnv } from "./helpers/env.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
let mock;
let cfgFile;

before(async () => {
  mock = await startMockFlarum({ forumRoot: makeForumRoot() });
  cfgFile = join(mkdtempSync(join(tmpdir(), "flarum2-ops-cli-")), "forum.json");
  writeFileSync(cfgFile, JSON.stringify({ name: "test", base_url: mock.base }));
});
after(() => mock.close());

/** Async on purpose: the mock server runs in this process and must keep answering. */
const cli = (...args) =>
  new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: cleanEnv({ FLARUM2_OPS_CONFIG: cfgFile, FLARUM_API_KEY: ADMIN_TOKEN, FLARUM_ROOT: "" }), timeout: 20_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });

test("settings reset dry run exits 3 (dry run), not 1 (blocked)", async () => {
  const r = await cli("settings", "reset", "custom_footer");
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stderr, /Dry run: nothing was changed/);
});

test("settings reset of a refused key exits 1 (blocked)", async () => {
  const r = await cli("settings", "reset", "extensions_enabled");
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /Blocked/);
});

test("api refuses writes to policy-checked endpoints, even with --confirm", async () => {
  const n = mock.requests.length;
  const r = await cli("api", "POST", "/settings?x=1", '{"extensions_enabled":"[]"}', "--confirm");
  assert.equal(r.code, 1, r.stderr);
  assert.match(JSON.parse(r.stdout).error, /refused here: use `settings set\|reset`/);
  assert.equal(mock.requests.filter((x) => x.method === "POST").length, mock.requests.slice(0, n).filter((x) => x.method === "POST").length);
});

test("permission accepts 'none' (no group), the form `restore` prints for an empty list", async () => {
  const r = await cli("permission", "viewForum", "none");
  assert.equal(r.code, 3, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).newGroupIds, []);
  const bad = await cli("permission", "viewForum", "1,x");
  assert.equal(bad.code, 1);
});

test("designset validate exits 1 when the set has errors, 0 when it is valid", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const sets = join(dirname(cfgFile), "design-sets");
  mkdirSync(join(sets, "good"), { recursive: true });
  writeFileSync(join(sets, "good", "set.json"), JSON.stringify({ name: "good", title: "Good", settings: {} }));
  mkdirSync(join(sets, "bad"), { recursive: true });
  // An error validate finds without a local install: the folder and the name in set.json differ.
  writeFileSync(join(sets, "bad", "set.json"), JSON.stringify({ name: "other-name", title: "Bad", settings: {} }));
  const good = await cli("designset", "validate", "good");
  assert.equal(good.code, 0, good.stdout + good.stderr);
  const bad = await cli("designset", "validate", "bad");
  assert.equal(bad.code, 1, bad.stdout);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  // Without a local install, setting values are still validated.
  mkdirSync(join(sets, "colour"), { recursive: true });
  writeFileSync(join(sets, "colour", "set.json"), JSON.stringify({ name: "colour", title: "C", settings: { theme_primary_color: "not-a-colour" } }));
  const colour = await cli("designset", "validate", "colour");
  assert.equal(colour.code, 1, colour.stdout);
});

test("a non-numeric FLARUM_TIMEOUT is ignored instead of becoming a 1 ms timeout", async () => {
  const { envPositiveNumber } = await import("../dist/config.js");
  assert.equal(envPositiveNumber("abc"), undefined);
  assert.equal(envPositiveNumber("-5"), undefined);
  assert.equal(envPositiveNumber(""), undefined);
  assert.equal(envPositiveNumber("45000"), 45000);
});

test("large JSON output through a pipe arrives complete", async () => {
  for (let i = 2; i < 2000; i++) mock.tags.set(String(i), { id: String(i), slug: `tag-${i}`, name: `Tag ${i} ${"x".repeat(40)}`, color: "#123456", icon: null, description: "" });
  const r = await cli("api", "GET", "/tags");
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.length > 65536, String(r.stdout.length));
  assert.equal(JSON.parse(r.stdout).body.data.length, mock.tags.size);
});

test("api exits 1 on an HTTP error", async () => {
  const r = await cli("api", "GET", "/nonexistent");
  assert.equal(r.code, 1, r.stdout);
  assert.equal(JSON.parse(r.stdout).status, 404);
});

test("login over plain http to a remote host is refused unless --allow-insecure-http", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "flarum2-ops-insecure-"));
  const file = join(dir, "forum.json");
  writeFileSync(file, JSON.stringify({ base_url: "http://forum.example.invalid" }));
  const r = await new Promise((resolve) => {
    execFile(process.execPath, [CLI, "login"], { env: cleanEnv({ FLARUM2_OPS_CONFIG: file }), timeout: 10_000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stderr }));
  });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /Refusing to log in/);
});

test("missing arguments are usage errors (exit 2), not TypeErrors", async () => {
  for (const args of [["designset", "new"], ["designset", "export"], ["image", "upload", "logo"]]) {
    const r = await cli(...args);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /must be of type string/);
  }
});
