import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FlarumClient } from "../dist/flarum-client.js";
import { Ops } from "../dist/ops.js";
import { DesignSets, checkScreenshotOpts, interruptWrites, writeInProgress } from "../dist/designset.js";
import { startMockFlarum, makeForumRoot, ADMIN_TOKEN, MEMBER_TOKEN, normalisedState, pngBytes } from "./helpers/mock-flarum.mjs";
import { cleanEnv } from "./helpers/env.mjs";

let mock;
let root;
let sets;

function makeSets() {
  const cfg = {
    name: "test",
    baseUrl: mock.base,
    forumRoot: root,
    tokenFile: "/nonexistent",
    designSetsDir: join(root, "design-sets"),
    publicAssetsSubdir: "design-sets",
    services: [],
    repoRoot: root,
    source: "test",
  };
  return new DesignSets(new Ops(cfg, new FlarumClient({ baseUrl: mock.base, apiKey: ADMIN_TOKEN }), mock.settingsStore));
}

/** Write a set folder from a spec object + extra files. */
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

beforeEach(async () => {
  root = makeForumRoot();
  mock = await startMockFlarum({
    forumRoot: root,
    settings: { custom_header: "<p>old header</p>", welcome_title: "Welcome!" },
  });
  sets = makeSets();
});
afterEach(async () => {
  await mock.close();
});

// --------------------------------------------------------------- authoring

test("new creates a valid set from the template", async () => {
  const res = sets.create("ocean-blue", "Ocean Blue");
  assert.ok(existsSync(join(res.created, "set.json")));
  assert.equal(sets.load("ocean-blue").title, "Ocean Blue");
  const v = await sets.validate("ocean-blue");
  assert.equal(v.ok, true, JSON.stringify(v.issues));
  assert.throws(() => sets.create("ocean-blue"), /already exists/);
  assert.throws(() => sets.create("Bad Name"), /invalid design-set name/);
});

test("validate rejects schema errors, unknown keys, .php statics, missing assets and unlisted extension keys", async () => {
  writeSet(
    "broken",
    {
      settings: { theme_primary_color: "blue", color_scheme: "midnight", mystery_setting: "x", "flarum-tags.max_primary_tags": "2" },
      less: "custom.less",
    },
    { "custom.less": ".a{src:url('@@ASSET:fonts/missing.woff2@@')}", "static/evil.php": "<?php echo 1;" },
  );
  const { ok, issues } = await sets.validate("broken");
  assert.equal(ok, false);
  const text = issues.map((i) => `${i.key}: ${i.message}`).join("\n");
  assert.match(text, /theme_primary_color: must be a hex color/);
  assert.match(text, /color_scheme: must be one of/);
  assert.match(text, /mystery_setting: not a design key/);
  assert.match(text, /flarum-tags\.max_primary_tags: extension key: add "flarum-tags" to requires_extensions/);
  assert.match(text, /static\/evil\.php: file type not allowed/);
  assert.match(text, /@@ASSET:fonts\/missing\.woff2@@ refers to a file that is not in static/);
});

test("validate catches a folder/name mismatch and unknown tag slugs", async () => {
  writeSet("aaa", { name: "bbb" });
  assert.match((await sets.validate("aaa")).issues[0].message, /folder is "aaa"/);
  writeSet("tagged", { tags: { nope: { color: "#ff0000" } } });
  assert.match(JSON.stringify((await sets.validate("tagged")).issues), /no tag with slug \\"nope\\"/);
});

test("validate warns when @body-bg-dark is redefined without beating the inline dark body background", async () => {
  writeSet("darkbg", { settings: { color_scheme: "dark" }, less: "c.less" }, { "c.less": "@body-bg-dark: #2E3440;" });
  assert.match(JSON.stringify((await sets.validate("darkbg")).issues), /inline critical CSS/);
  writeSet("darkbg-ok", { settings: { color_scheme: "dark" }, less: "c.less" }, { "c.less": "@body-bg-dark: #2E3440;\nhtml[data-theme^=dark] body { background: var(--body-bg); }" });
  assert.doesNotMatch(JSON.stringify((await sets.validate("darkbg-ok")).issues), /inline critical CSS/);
});

// -------------------------------------------------------------------- plan

test("plan lists changes from → to and resets omitted theme keys to defaults", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155", color_scheme: "dark" } });
  const plan = await sets.plan("slate");
  assert.equal(plan.blocked, false, JSON.stringify(plan.issues));
  const byKey = Object.fromEntries(plan.settings.map((s) => [s.key, s]));
  assert.equal(byKey.theme_primary_color.to, "#334155");
  assert.equal(byKey.color_scheme.from, "auto");
  assert.equal(byKey.custom_header.action, "reset");
  assert.equal(byKey.theme_colored_header.action, "reset");
  assert.ok(!("welcome_title" in byKey), "optional keys untouched when the set does not list them");
  assert.equal(plan.needsCacheClear, false);
});

test("apply without confirm is a dry run and never writes", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" } });
  const before = normalisedState(mock.store);
  const res = await sets.apply("slate");
  assert.equal(res.dryRun, true);
  assert.deepEqual(normalisedState(mock.store), before);
  assert.equal(mock.requests.filter((r) => r.method !== "GET").length, 0);
});

// ------------------------------------------------------------------- apply

test("apply: snapshot first, custom_less alone, assets resolved + copied, images, tags, marker", async () => {
  writeSet(
    "amber",
    {
      settings: { theme_primary_color: "#B45309", theme_secondary_color: "#1F2937", theme_colored_header: true, color_scheme: "auto" },
      less: "custom.less",
      footer: "footer.html",
      images: { logo: "images/logo.png" },
      tags: { general: { color: "#B45309", icon: "fas fa-fire" } },
    },
    {
      "custom.less": "@font-face{font-family:X;src:url('@@ASSET:fonts/x.woff2@@') format('woff2')}\nhtml{.Hero{color:red}}",
      "footer.html": "<footer>amber</footer>",
      "static/fonts/x.woff2": "WOFF2DATA",
      "images/logo.png": pngBytes(400, 120),
    },
  );
  const res = await sets.apply("amber", { confirm: true });
  assert.equal(res.dryRun, false, JSON.stringify(res));

  const writes = mock.requests.filter((r) => r.method !== "GET");
  const firstSettingsPost = writes.find((r) => r.path === "/api/settings" && r.method === "POST");
  assert.deepEqual(Object.keys(JSON.parse(firstSettingsPost.body)), ["custom_less"], "custom_less is sent alone first");

  const less = mock.store.get("custom_less");
  const m = /url\('\/assets\/design-sets\/amber\/([0-9a-f]{8})\/fonts\/x\.woff2'\)/.exec(less);
  assert.ok(m, less);
  assert.equal(readFileSync(join(root, "public", "assets", "design-sets", "amber", m[1], "fonts", "x.woff2"), "utf8"), "WOFF2DATA");
  assert.equal(mock.store.get("theme_colored_header"), "1");
  assert.equal(mock.store.get("custom_footer"), "<footer>amber</footer>");
  assert.equal(mock.store.has("custom_header"), false, "omitted theme key reset to default");
  assert.equal(mock.store.get("welcome_title"), "Welcome!", "optional key untouched");
  assert.match(mock.store.get("logo_path"), /^logo-/);
  assert.equal(mock.tags.get("1").color, "#B45309");
  assert.equal(sets.marker().set, "amber");
  assert.ok(sets.listSnapshots().length >= 1);
  assert.match(res.logEntry, /design-set apply: amber/);
});

test("apply is idempotent: a second apply of the same set changes nothing", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" }, images: { favicon: "images/f.png" } }, { "images/f.png": pngBytes(64, 64) });
  await sets.apply("slate", { confirm: true });
  const plan = await sets.plan("slate");
  assert.deepEqual(plan.settings, []);
  assert.deepEqual(plan.images.filter((i) => i.action !== "keep"), []);
});

test("a rejected custom_less (422) during apply rolls the forum back automatically", async () => {
  const before = normalisedState(mock.store);
  writeSet("bad-less", { settings: { theme_primary_color: "#000000" }, less: "custom.less" }, { "custom.less": ".a{BROKEN}" });
  await assert.rejects(() => sets.apply("bad-less", { confirm: true }), /custom_less rejected \(422\)[\s\S]*rolled back/);
  assert.deepEqual(normalisedState(mock.store), before);
  assert.equal(mock.store.has("custom_less_error"), false, "the restore save clears custom_less_error");
});

test("a failure after partial writes rolls back every step (settings, images, tags)", async () => {
  // Tags are written after settings and images, so the settings and the favicon are live when the tag fails.
  mock.behaviour.failTagPatch = true;
  const before = normalisedState(mock.store);
  const tagBefore = { ...mock.tags.get("1") };
  writeSet(
    "half",
    {
      settings: { theme_primary_color: "#111111", theme_secondary_color: "#222222" },
      less: "c.less",
      images: { favicon: "images/f.png" },
      tags: { general: { color: "#123456" } },
    },
    { "c.less": ".ok{color:red}", "images/f.png": pngBytes(64, 64) },
  );
  try {
    await assert.rejects(() => sets.apply("half", { confirm: true }), /rolled back/);
  } finally {
    mock.behaviour.failTagPatch = false;
  }
  const uploads = mock.requests.filter((r) => r.method === "POST" && r.path === "/api/favicon");
  assert.equal(uploads.length, 1, "the favicon was really uploaded before the failure");
  // Flarum's DeleteFaviconController stores NULL rather than deleting the key, so compare the path by presence.
  const after = normalisedState(mock.store);
  assert.equal(after.favicon_path ?? null, null, "no favicon after the rollback");
  delete after.favicon_path;
  assert.deepEqual(after, before);
  assert.deepEqual(mock.tags.get("1"), tagBefore);
});

// ---------------------------------------------------------------- rollback

test("rollback restores absent, NULL and value states exactly", async () => {
  mock.store.set("custom_footer", null); // a NULL row (e.g. after an admin cleared it)
  const before = normalisedState(mock.store);
  writeSet("x", { settings: { theme_primary_color: "#0F766E", show_theme_selector: false }, footer: "f.html", less: "c.less" }, { "f.html": "<b>f</b>", "c.less": ".a{color:red}" });
  const res = await sets.apply("x", { confirm: true });
  assert.notDeepEqual(normalisedState(mock.store), before);

  const dry = await sets.rollback(res.snapshot);
  assert.equal(dry.dryRun, true);
  assert.ok(dry.settings.length > 0);

  const rb = await sets.rollback(res.snapshot, { confirm: true });
  assert.equal(rb.verify.ok, true, JSON.stringify(rb.verify));
  assert.deepEqual(normalisedState(mock.store), before);
  assert.equal(mock.store.get("custom_footer"), null, "NULL row restored as NULL, not deleted");
  assert.equal(mock.store.has("show_theme_selector"), false, "key absent before is deleted again");
  assert.equal(sets.marker(), null, "applied marker restored");
});

test("rollback re-uploads a removed logo and removes one that did not exist", async () => {
  // Start with a logo, apply a set that deletes it and adds a favicon.
  writeFileSync(join(root, "public", "assets", "logo-orig.webp"), pngBytes());
  mock.store.set("logo_path", "logo-orig.webp");
  writeSet("swap", { images: { logo: null, favicon: "images/f.png" } }, { "images/f.png": pngBytes(64, 64) });
  const res = await sets.apply("swap", { confirm: true });
  assert.equal(mock.store.get("logo_path"), null);
  assert.ok(mock.store.get("favicon_path"));
  await sets.rollback(res.snapshot, { confirm: true });
  assert.match(mock.store.get("logo_path"), /^logo-/, "logo re-uploaded from the snapshot copy");
  assert.equal(mock.store.get("favicon_path"), null, "favicon that did not exist is removed");
});

test("rollback restores a NULL tag icon as NULL, not as an empty string", async () => {
  mock.tags.get("1").icon = null;
  writeSet("iconic", { tags: { general: { icon: "fas fa-star" } } });
  const res = await sets.apply("iconic", { confirm: true });
  assert.equal(mock.tags.get("1").icon, "fas fa-star");
  await sets.rollback(res.snapshot, { confirm: true });
  assert.strictEqual(mock.tags.get("1").icon, null);
});

// ----------------------------------------------------------------- preview

test("preview applies, screenshots and always rolls back", async () => {
  const fake = join(root, "fake-python");
  writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho \'{"count":2,"shots":[{"file":"home__light__1440.png"}],"problems":[],"ok":true}\'\n');
  chmodSync(fake, 0o755);
  process.env.FLARUM2_OPS_PYTHON = fake;
  try {
    const before = normalisedState(mock.store);
    writeSet("trial", { settings: { theme_primary_color: "#7C3AED", color_scheme: "dark" } });
    const res = await sets.preview("trial", { confirm: true });
    assert.equal(res.screenshots.count, 2);
    assert.equal(res.rollback.ok, true);
    assert.deepEqual(normalisedState(mock.store), before);
  } finally {
    delete process.env.FLARUM2_OPS_PYTHON;
  }
});

test("preview fails loudly when its automatic rollback does not restore the forum", async () => {
  const fake = join(root, "fake-python");
  writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho \'{"count":0,"shots":[],"problems":[],"ok":true}\'\n');
  chmodSync(fake, 0o755);
  process.env.FLARUM2_OPS_PYTHON = fake;
  try {
    writeSet("trial", { settings: { theme_primary_color: "#7C3AED" } });
    sets.rollbackInner = async () => ({ steps: [], verify: { ok: false, remaining: { settings: [{ key: "theme_primary_color" }] } } });
    await assert.rejects(() => sets.preview("trial", { confirm: true }), /DID NOT FULLY RESTORE[\s\S]*designset rollback \S+-before-preview-trial/);
    sets.rollbackInner = async () => {
      throw new Error("boom");
    };
    await assert.rejects(() => sets.preview("trial", { confirm: true }), /AUTOMATIC ROLLBACK FAILED: boom[\s\S]*designset rollback /);
  } finally {
    delete process.env.FLARUM2_OPS_PYTHON;
  }
});

test("a missing or outside image gives a blocked plan, not a crash", async () => {
  writeSet("noimg", { images: { logo: "images/logo.png" } });
  const plan = await sets.plan("noimg");
  assert.equal(plan.blocked, true);
  assert.ok(plan.issues.some((i) => i.key === "images.logo" && i.level === "error"));
  const dry = await sets.apply("noimg", { confirm: true });
  assert.equal(dry.dryRun, true);
  writeSet("escape", { images: { logo: "../../package.json" } });
  assert.equal((await sets.plan("escape")).blocked, true);
});

test("confirmed Ops writes snapshot first (restorable by rollback) and read back the result", async () => {
  const ops = sets.ops;
  mock.store.set("forum_title", "Before");
  const set = await ops.settingsSet({ forum_title: "After" }, { confirm: true });
  assert.match(String(set.snapshot), /before-settings-set/);
  assert.equal(set.verify.ok, true);

  const reset = await ops.settingsReset(["welcome_title"], { confirm: true });
  assert.match(String(reset.snapshot), /before-settings-reset/);
  assert.equal(reset.verify.ok, true);
  assert.equal(mock.store.has("welcome_title"), false);

  const file = join(root, "logo-src.png");
  writeFileSync(file, pngBytes(400, 100));
  const up = await ops.uploadImage("logo", file, { confirm: true });
  assert.equal(up.verify.ok, true);
  const del = await ops.deleteImage("logo", { confirm: true });
  assert.equal(del.verify.ok, true);
  assert.match(String(del.snapshot), /before-delete-logo/);

  const perm = await ops.permissionSet("startDiscussion", [3, 4], { confirm: true });
  assert.equal(perm.verify.ok, true);
  assert.equal(perm.restore, "permission startDiscussion 3");
  mock.permissions.emptyOne = [];
  assert.equal((await ops.permissionSet("emptyOne", [1], { confirm: true })).restore, "permission emptyOne none");

  // The reset snapshot restores the title and the welcome text, which are outside the design keys too.
  await sets.rollback(set.snapshot, { confirm: true });
  assert.equal(mock.store.get("forum_title"), "Before");
  assert.equal(mock.store.get("welcome_title"), "Welcome!");
});

test("snapshots taken in the same millisecond get distinct ids and never overwrite each other", async () => {
  const realNow = Date.now;
  Date.now = () => 1795000000000;
  try {
    mock.store.set("forum_title", "Original");
    const a = await sets.snapshot("same", ["forum_title"]);
    mock.store.set("forum_title", "Changed");
    const b = await sets.snapshot("same", ["forum_title"]);
    assert.notEqual(a.id, b.id);
    const first = JSON.parse(readFileSync(join(sets.snapshotsDir, a.id, "snapshot.json"), "utf8"));
    assert.equal(first.settings.forum_title.value, "Original");
  } finally {
    Date.now = realNow;
  }
});

test("a settings write still snapshots when GET /tags fails; apply snapshots do not tolerate it", async () => {
  const ops = sets.ops;
  const realRequest = ops.client.request.bind(ops.client);
  ops.client.request = async (req) => {
    if (req.path === "/tags") throw new Error("tags 500");
    return realRequest(req);
  };
  try {
    const res = await ops.settingsSet({ forum_title: "T" }, { confirm: true });
    const snap = JSON.parse(readFileSync(join(sets.snapshotsDir, res.snapshot, "snapshot.json"), "utf8"));
    assert.equal(snap.tagsError, "tags 500");
    const before = sets.listSnapshots().length;
    await assert.rejects(() => sets.snapshot("strict"), /tags 500/);
    assert.equal(sets.listSnapshots().length, before);
    assert.deepEqual(readdirSync(sets.snapshotsDir).filter((d) => !existsSync(join(sets.snapshotsDir, d, "snapshot.json"))), []);
  } finally {
    ops.client.request = realRequest;
  }
});

test("a write that fails after its snapshot names the snapshot to restore from", async () => {
  mock.behaviour.failSettingsKey = "forum_title";
  try {
    await assert.rejects(
      () => sets.ops.settingsSet({ custom_less: ".ok{color:red}", forum_title: "X" }, { confirm: true }),
      (err) => /settings write failed \(500\)/.test(err.message) && /restore with: designset rollback \S+-before-settings-set/.test(err.message) && err.steps.length > 0,
    );
  } finally {
    mock.behaviour.failSettingsKey = null;
  }
});

test("settings/image writes are refused while a design-set write holds the lock", async () => {
  mkdirSync(join(root, "design-sets"), { recursive: true });
  writeFileSync(join(root, "design-sets", ".lock"), `${process.ppid} ${new Date().toISOString()}\n`);
  const n = mock.requests.filter((r) => r.method === "POST").length;
  await assert.rejects(() => sets.ops.settingsSet({ forum_title: "Y" }, { confirm: true }), /another design-set write is running/);
  assert.equal(mock.requests.filter((r) => r.method === "POST").length, n);
});

test("set files outside the set (.., absolute, symlinks) are never published", async () => {
  const secret = join(root, "secret.txt");
  writeFileSync(secret, "SECRET-ADMIN-TOKEN");
  mkdirSync(join(root, "outside"), { recursive: true });
  writeFileSync(join(root, "outside", "private.png"), pngBytes());

  // header.html is a symlink to a file outside the set
  const dir = writeSet("evil", { header: "header.html" });
  symlinkSync(secret, join(dir, "header.html"));
  let plan = await sets.plan("evil");
  assert.equal(plan.blocked, true);
  assert.ok(plan.issues.some((i) => i.key === "custom_header" && i.level === "error"));
  assert.equal((await sets.apply("evil", { confirm: true })).dryRun, true);
  assert.doesNotMatch(String(mock.store.get("custom_header")), /SECRET/);

  // static points outside the set
  writeSet("evil2", { static: "../../outside" });
  plan = await sets.plan("evil2");
  assert.equal(plan.blocked, true);
  assert.ok(plan.issues.some((i) => i.key === "static"));

  // a symlinked file inside static/ is flagged and never copied
  const d3 = writeSet("evil3", {}, { "static/ok.png": pngBytes() });
  symlinkSync(join(root, "outside", "private.png"), join(d3, "static", "leak.png"));
  plan = await sets.plan("evil3");
  assert.ok(plan.issues.some((i) => i.key === "static/leak.png" && i.level === "error"));

  // an image that is a symlink to outside
  const d4 = writeSet("evil4", { images: { logo: "images/logo.png" } });
  mkdirSync(join(d4, "images"), { recursive: true });
  symlinkSync(join(root, "outside", "private.png"), join(d4, "images", "logo.png"));
  assert.equal((await sets.plan("evil4")).blocked, true);

  const published = join(root, "public", "assets", "design-sets");
  const all = existsSync(published) ? readdirSync(published, { recursive: true }).map(String) : [];
  assert.equal(all.some((f) => /private|leak/.test(f)), false, all.join(","));
});

test("a symlink inside the set to a file inside the set is fine", async () => {
  const dir = writeSet("linked", { header: "header.html" }, { "parts/h.html": "<p>inner</p>" });
  symlinkSync(join(dir, "parts", "h.html"), join(dir, "header.html"));
  const plan = await sets.plan("linked");
  assert.equal(plan.blocked, false, JSON.stringify(plan.issues));
});

test("rollback leaves settings of an extension enabled after the snapshot alone", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" } });
  const applied = await sets.apply("slate", { confirm: true });
  // after the snapshot: a new extension is enabled and configured
  mock.store.set("extensions_enabled", JSON.stringify(["flarum-tags", "fof-upload"]));
  mock.store.set("fof-upload.maxFileSize", "4096");
  const dry = await sets.rollback(applied.snapshot);
  assert.equal(JSON.stringify(dry).includes("fof-upload.maxFileSize"), false, "not part of the rollback plan");
  await sets.rollback(applied.snapshot, { confirm: true });
  assert.equal(mock.store.get("fof-upload.maxFileSize"), "4096");
  assert.equal(mock.store.get("theme_primary_color"), "#4D698E");
});

test("preview or a failed apply never removes static files the restored LESS still references", async () => {
  const fontUrl = () => /design-sets\/brand\/([0-9a-f]{8})\/fonts\/(\w)\.woff2/.exec(String(mock.store.get("custom_less")));
  const dir = writeSet("brand", { less: "custom.less" }, { "custom.less": "@font-face{src:url('@@ASSET:fonts/a.woff2@@')}", "static/fonts/a.woff2": "AAAA" });
  await sets.apply("brand", { confirm: true });
  const [, v1] = fontUrl();
  const fileFor = (v, f) => join(root, "public", "assets", "design-sets", "brand", v, "fonts", `${f}.woff2`);
  assert.equal(readFileSync(fileFor(v1, "a"), "utf8"), "AAAA");

  // edit the set: a.woff2 -> b.woff2, then a preview and a failing apply
  rmSync(join(dir, "static", "fonts", "a.woff2"));
  writeFileSync(join(dir, "static", "fonts", "b.woff2"), "BBBB");
  writeFileSync(join(dir, "custom.less"), "@font-face{src:url('@@ASSET:fonts/b.woff2@@')}");
  const fake = join(root, "fake-python");
  writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho \'{"count":0,"shots":[],"problems":[],"ok":true}\'\n');
  chmodSync(fake, 0o755);
  process.env.FLARUM2_OPS_PYTHON = fake;
  try {
    await sets.preview("brand", { confirm: true });
  } finally {
    delete process.env.FLARUM2_OPS_PYTHON;
  }
  // failing apply: the mock rejects this LESS with 422 after the static files were published
  writeFileSync(join(dir, "custom.less"), "@font-face{src:url('@@ASSET:fonts/b.woff2@@')} .x{BROKEN}");
  await assert.rejects(() => sets.apply("brand", { confirm: true }), /rolled back/);
  writeFileSync(join(dir, "custom.less"), "@font-face{src:url('@@ASSET:fonts/b.woff2@@')}");

  // live LESS is the restored one and its font is still there, unchanged
  const [, vLive, f] = fontUrl();
  assert.equal(vLive, v1);
  assert.equal(f, "a");
  assert.equal(readFileSync(fileFor(v1, "a"), "utf8"), "AAAA");

  // a successful apply publishes the new version; the old one stays while a snapshot references it
  await sets.apply("brand", { confirm: true });
  const [, v2] = fontUrl();
  assert.notEqual(v2, v1);
  assert.equal(readFileSync(fileFor(v2, "b"), "utf8"), "BBBB");
  assert.equal(existsSync(fileFor(v1, "a")), true);

  // once no snapshot references the old version any more, the next successful apply removes it
  rmSync(sets.snapshotsDir, { recursive: true, force: true });
  await sets.apply("brand", { confirm: true });
  assert.equal(existsSync(fileFor(v1, "a")), false);
  assert.equal(readFileSync(fileFor(v2, "b"), "utf8"), "BBBB");
});

// Answers the pre-flight probe at once, then hangs on the real screenshot request.
// `exec`: the sleep replaces the shell, so killing the helper really kills what hangs (a plain `sleep` would be a
// grandchild, and the test would only pass after 30 s through the ordinary failure path).
const HANGS_AFTER_PROBE = 'input=$(cat)\ncase "$input" in *probe*) echo \'{"ok":true,"probe":true}\';; *) exec sleep 30;; esac';
// A plain `sleep` is a grandchild of the helper's shell, like Chromium is of Python: the kill must reach it too.
const HANGS_IN_GRANDCHILD = 'input=$(cat)\ncase "$input" in *probe*) echo \'{"ok":true,"probe":true}\';; *) sleep 30;; esac';

function fakePython(body) {
  const fake = join(root, `fake-python-${Math.random().toString(36).slice(2)}`);
  writeFileSync(fake, `#!/bin/sh\n${body}\n`);
  chmodSync(fake, 0o755);
  return fake;
}

async function withPython(path, fn, extraEnv = {}) {
  const saved = { ...process.env };
  process.env.FLARUM2_OPS_PYTHON = path;
  Object.assign(process.env, extraEnv);
  try {
    return await fn();
  } finally {
    for (const k of ["FLARUM2_OPS_PYTHON", ...Object.keys(extraEnv)]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("a hanging screenshot helper is killed after the timeout and the preview rolls back", async () => {
  const before = normalisedState(mock.store);
  writeSet("trial", { settings: { theme_primary_color: "#00ff00" } });
  await withPython(fakePython(HANGS_AFTER_PROBE), async () => {
    await assert.rejects(() => sets.preview("trial", { confirm: true }), /preview failed[\s\S]*killed by SIGKILL/);
  }, { FLARUM2_OPS_SCREENSHOT_TIMEOUT_MS: "300" });
  assert.deepEqual(normalisedState(mock.store), before);
  assert.equal(writeInProgress(), false);
  assert.equal(existsSync(join(root, "design-sets", ".lock")), false);
});

test("the screenshot timeout also kills the helper's own children (no 30 s wait for a grandchild)", async () => {
  writeSet("trial", { settings: { theme_primary_color: "#00ff00" } });
  const t0 = Date.now();
  await withPython(fakePython(HANGS_IN_GRANDCHILD), async () => {
    await assert.rejects(() => sets.preview("trial", { confirm: true }), /killed by SIGKILL \(timeout/);
  }, { FLARUM2_OPS_SCREENSHOT_TIMEOUT_MS: "300" });
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

test("helpers never see our credentials in their environment", async () => {
  const out = join(root, "helper-env.txt");
  process.env.FLARUM_API_KEY = "must-not-leak-123";
  try {
    await withPython(fakePython(`env > ${out}\necho '{"ok":true,"count":0,"shots":[],"problems":[]}'`), () => sets.screenshot({ outDir: join(root, "shots") }));
  } finally {
    delete process.env.FLARUM_API_KEY;
  }
  assert.equal(readFileSync(out, "utf8").includes("must-not-leak-123"), false);
});

test("an interrupt (Ctrl+C / SIGTERM) during preview stops the helper and rolls back; later writes work", async () => {
  const before = normalisedState(mock.store);
  writeSet("trial", { settings: { theme_primary_color: "#00ff00" } });
  await withPython(fakePython(HANGS_AFTER_PROBE), async () => {
    const running = sets.preview("trial", { confirm: true });
    for (let i = 0; mock.store.get("theme_primary_color") !== "#00ff00"; i++) {
      assert.ok(i < 500, "preview never applied");
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    interruptWrites();
    await assert.rejects(running, /preview failed[\s\S]*(killed by SIGKILL|interrupted by a signal)/);
    assert.ok(Date.now() - t0 < 5000, "the interrupt itself ended the preview");
  });
  assert.deepEqual(normalisedState(mock.store), before);
  writeSet("slate", { settings: { theme_primary_color: "#334155" } });
  await sets.apply("slate", { confirm: true });
  assert.equal(mock.store.get("theme_primary_color"), "#334155");
});

test("an unusable screenshot helper (exits without reading stdin: EPIPE) stops the preview before anything is applied", async () => {
  const before = normalisedState(mock.store);
  writeSet("trial", { settings: { theme_primary_color: "#00ff00" } });
  const writes = () => mock.requests.filter((r) => r.method !== "GET").length;
  const n = writes();
  await withPython("/bin/true", async () => {
    await assert.rejects(() => sets.preview("trial", { confirm: true }), /screenshots are not available, so nothing was applied/);
  });
  assert.equal(writes(), n, "no write request was sent");
  assert.deepEqual(normalisedState(mock.store), before);
  assert.equal(sets.listSnapshots().length, 0);
});

test("a helper that dies mid-preview (after the probe) fails the preview cleanly and rolls back", async () => {
  const before = normalisedState(mock.store);
  writeSet("trial", { settings: { theme_primary_color: "#00ff00" } });
  const dies = fakePython('input=$(cat)\ncase "$input" in *probe*) echo \'{"ok":true}\';; *) exit 3;; esac');
  await withPython(dies, async () => {
    await assert.rejects(() => sets.preview("trial", { confirm: true }), /preview failed[\s\S]*exit 3/);
  });
  assert.deepEqual(normalisedState(mock.store), before);
});

test("doctor reports an interrupted write (lock of a dead process) and names its pre-write snapshot", async () => {
  mkdirSync(join(root, "design-sets"), { recursive: true });
  const since = new Date(Date.now() - 1000).toISOString();
  writeFileSync(join(root, "design-sets", ".lock"), `999999999 ${since}\n`);
  const snap = await sets.snapshot("before-apply-x");
  const d = await sets.doctor();
  assert.ok(d.problems.some((p) => /interrupted/.test(p) && p.includes(snap.id)), JSON.stringify(d.problems));
});

test("rollback snapshots the current state first, so it can itself be undone", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" } });
  const applied = await sets.apply("slate", { confirm: true });
  const res = await sets.rollback(applied.snapshot, { confirm: true });
  assert.equal(mock.store.get("theme_primary_color"), "#4D698E");
  assert.match(res.preRollbackSnapshot, /before-rollback/);
  await sets.rollback(res.preRollbackSnapshot, { confirm: true });
  assert.equal(mock.store.get("theme_primary_color"), "#334155");
});

test("rollback without an id targets the last pre-write snapshot, never an export, manual or rollback snapshot", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" } });
  const applied = await sets.apply("slate", { confirm: true });
  await sets.snapshot("manual");
  await sets.exportLive("copy");
  const dry = await sets.rollback(undefined);
  assert.equal(dry.snapshot, applied.snapshot);
  assert.equal(dry.confirmWith, `designset rollback ${applied.snapshot} --confirm`);
  await sets.rollback(undefined, { confirm: true });
  assert.equal((await sets.rollback(undefined)).snapshot, applied.snapshot, "the rollback's own snapshot is not the new default");
  assert.throws(() => sets.loadSnapshot(".."), /invalid snapshot id|not found/);
});

test("screenshot pages must be forum paths (no SSRF to other hosts); preview checks before applying", async () => {
  for (const bad of ["@169.254.169.254/latest/", "//evil.example/", "/\\evil", "http://evil/", "/a b", "relative"]) {
    assert.throws(() => checkScreenshotOpts({ pages: [bad] }), /not a forum path/, bad);
  }
  checkScreenshotOpts({ pages: ["/", "/all", "/d/1-hello", "/t/general?sort=latest"], viewports: [1440, 390] });
  assert.throws(() => checkScreenshotOpts({ viewports: [10] }), /viewport/);
  const before = normalisedState(mock.store);
  writeSet("trial", { settings: { theme_primary_color: "#00ff00" } });
  await assert.rejects(() => sets.preview("trial", { confirm: true, pages: ["@169.254.169.254/"] }), /not a forum path/);
  assert.deepEqual(normalisedState(mock.store), before, "nothing was applied");
});

test("apply A (logo) -> apply B (logo) -> rollback restores A's logo bytes", async () => {
  writeSet("a", { images: { logo: "images/logo.png" } }, { "images/logo.png": pngBytes(400, 100) });
  writeSet("b", { images: { logo: "images/logo.png" } }, { "images/logo.png": pngBytes(500, 120) });
  await sets.apply("a", { confirm: true });
  const aFile = join(root, "public", "assets", mock.store.get("logo_path"));
  const aBytes = readFileSync(aFile);
  assert.deepEqual(aBytes, pngBytes(400, 100), "the mock stores the uploaded file itself");
  const b = await sets.apply("b", { confirm: true });
  assert.equal(existsSync(aFile), false, "Flarum deletes the previous file on upload");
  await sets.rollback(b.snapshot, { confirm: true });
  assert.deepEqual(readFileSync(join(root, "public", "assets", mock.store.get("logo_path"))), aBytes);
});

test("re-applying a set re-uploads a logo that was replaced after the apply, and doctor reports it as drift", async () => {
  writeSet("a", { images: { logo: "images/logo.png" } }, { "images/logo.png": pngBytes(400, 100) });
  await sets.apply("a", { confirm: true });
  assert.equal((await sets.plan("a")).images.find((i) => i.kind === "logo").action, "keep");
  const manual = join(root, "manual.png");
  writeFileSync(manual, pngBytes(300, 90));
  await sets.ops.uploadImage("logo", manual, { confirm: true });
  assert.ok((await sets.doctor()).drift.includes("logo_path"));
  assert.equal((await sets.plan("a")).images.find((i) => i.kind === "logo").action, "upload");
  await sets.apply("a", { confirm: true });
  assert.deepEqual(readFileSync(join(root, "public", "assets", mock.store.get("logo_path"))), pngBytes(400, 100));
});

test("rollback keeps going after a failed step and reports every failure at the end", async () => {
  writeSet("full", { settings: { theme_primary_color: "#111111" }, images: { logo: "images/l.png" }, tags: { general: { color: "#123456" } } }, { "images/l.png": pngBytes(400, 100) });
  const applied = await sets.apply("full", { confirm: true });
  mock.behaviour.failTagPatch = true;
  try {
    await assert.rejects(() => sets.rollback(applied.snapshot, { confirm: true }), /rollback incomplete[\s\S]*restoring tag general failed/);
  } finally {
    mock.behaviour.failTagPatch = false;
  }
  // everything else was still restored
  assert.equal(mock.store.get("theme_primary_color"), "#4D698E");
  assert.equal(mock.store.get("logo_path") ?? null, null);
  assert.equal(mock.tags.get("1").color, "#123456", "only the failed tag is left");
});

test("a set that would replace an image a rollback cannot restore (.ico, no local file) is blocked", async () => {
  const ico = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0]);
  writeFileSync(join(root, "public", "assets", "favicon-old.ico"), ico);
  mock.store.set("favicon_path", "favicon-old.ico");
  writeSet("fav", { images: { favicon: "images/f.png" } }, { "images/f.png": pngBytes(64, 64) });
  let plan = await sets.plan("fav");
  assert.equal(plan.blocked, true);
  assert.ok(plan.issues.some((i) => i.key === "images.favicon" && /could not be restored by a rollback/.test(i.message)), JSON.stringify(plan.issues));
  mock.store.set("favicon_path", "on-a-remote-disk.png"); // no local file
  plan = await sets.plan("fav");
  assert.ok(plan.issues.some((i) => i.key === "images.favicon" && /not on the local assets disk/.test(i.message)));
  writeSet("nofav", { settings: { theme_primary_color: "#222222" } });
  assert.equal((await sets.plan("nofav")).blocked, false, "sets that leave the image alone are not affected");
});

test("an extension toggle is refused while a design-set write holds the lock", async () => {
  mkdirSync(join(root, "design-sets"), { recursive: true });
  writeFileSync(join(root, "design-sets", ".lock"), `${process.ppid} ${new Date().toISOString()}\n`);
  const n = mock.requests.filter((r) => r.method === "PATCH").length;
  await assert.rejects(() => sets.ops.extensionSet("flarum-gdpr", true, { confirm: true }), /another design-set write is running/);
  assert.equal(mock.requests.filter((r) => r.method === "PATCH").length, n);
});

test("a second rollback to the same snapshot does not upload the image again", async () => {
  writeSet("a", { images: { logo: "images/logo.png" } }, { "images/logo.png": pngBytes(400, 100) });
  writeSet("b", { images: { logo: "images/logo.png" } }, { "images/logo.png": pngBytes(500, 120) });
  await sets.apply("a", { confirm: true });
  const b = await sets.apply("b", { confirm: true });
  const uploads = () => mock.requests.filter((r) => r.method === "POST" && r.path === "/api/logo").length;
  await sets.rollback(b.snapshot, { confirm: true });
  const afterFirst = uploads();
  const path = mock.store.get("logo_path");
  const dry = await sets.rollback(b.snapshot);
  assert.deepEqual(dry.images, [], "nothing left to restore");
  await sets.rollback(b.snapshot, { confirm: true });
  assert.equal(uploads(), afterFirst, "no re-upload");
  assert.equal(mock.store.get("logo_path"), path);
});

test("a settings write that times out but lands later is undone too, not reported as rolled back too early", async () => {
  const saved = { t: process.env.FLARUM2_OPS_SETTINGS_TIMEOUT_MS, w: process.env.FLARUM2_OPS_LATE_WRITE_WAIT_MS };
  process.env.FLARUM2_OPS_SETTINGS_TIMEOUT_MS = "300";
  process.env.FLARUM2_OPS_LATE_WRITE_WAIT_MS = "800";
  writeSet("slow", { settings: { theme_primary_color: "#111111" } });
  mock.behaviour.slowSettingsMs = 600; // first POST: client gives up at 300 ms, the mock stores at 600 ms
  let first = true;
  const realRaw = sets.ops.client.raw.bind(sets.ops.client);
  sets.ops.client.raw = async (req) => {
    if (req.method === "POST" && req.path === "/settings" && !first) mock.behaviour.slowSettingsMs = 0;
    if (req.method === "POST" && req.path === "/settings") first = false;
    return realRaw(req);
  };
  try {
    await assert.rejects(() => sets.apply("slow", { confirm: true }), /timed out[\s\S]*(rolled back|landed after the timeout)/);
    await new Promise((r) => setTimeout(r, 700)); // past the moment the slow first write lands
    assert.equal(mock.store.get("theme_primary_color"), "#4D698E", "the late write was undone as well");
  } finally {
    mock.behaviour.slowSettingsMs = 0;
    sets.ops.client.raw = realRaw;
    for (const [k, v] of [["FLARUM2_OPS_SETTINGS_TIMEOUT_MS", saved.t], ["FLARUM2_OPS_LATE_WRITE_WAIT_MS", saved.w]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

for (const [what, arrange, cause] of [
  ["a read-back mismatch", (m) => (m.behaviour.ignoreSettingsKey = "theme_primary_color"), /verification after apply failed/],
  ["custom_less_error after the save", (m) => (m.behaviour.leaveLessError = true), /verification after apply failed/],
  ["a broken stylesheet in the health check", (m) => (m.behaviour.extraStylesheets = ["/assets/missing.css"]), /health check failed[\s\S]*missing\.css returned 404/],
]) {
  test(`apply rolls back on ${what}`, async () => {
    const before = normalisedState(mock.store);
    writeSet("chk", { settings: { theme_primary_color: "#111111" }, less: "c.less" }, { "c.less": ".a{color:red}" });
    arrange(mock);
    await assert.rejects(() => sets.apply("chk", { confirm: true }), (e) => cause.test(e.message) && /rolled back/.test(e.message));
    Object.assign(mock.behaviour, { ignoreSettingsKey: null, leaveLessError: false, extraStylesheets: [] });
    mock.store.delete("custom_less_error");
    assert.deepEqual(normalisedState(mock.store), before);
    assert.equal(sets.marker(), null, "nothing was marked as applied");
  });
}

test("apply with autoRollback:false leaves the forum as it is and names the snapshot", async () => {
  writeSet("chk", { settings: { theme_primary_color: "#111111" } });
  mock.behaviour.extraStylesheets = ["/assets/missing.css"];
  try {
    await assert.rejects(() => sets.apply("chk", { confirm: true, autoRollback: false }), /partially changed; restore with: designset rollback \S+-before-apply-chk/);
  } finally {
    mock.behaviour.extraStylesheets = [];
  }
  assert.equal(mock.store.get("theme_primary_color"), "#111111", "not rolled back");
});

test("preview stops (and rolls back) when the applied set does not verify", async () => {
  const before = normalisedState(mock.store);
  writeSet("trial", { settings: { theme_primary_color: "#00ff00" } });
  mock.behaviour.ignoreSettingsKey = "theme_primary_color";
  try {
    await withPython(fakePython('input=$(cat)\necho \'{"ok":true,"count":0,"shots":[],"problems":[]}\''), async () => {
      await assert.rejects(() => sets.preview("trial", { confirm: true }), /preview failed: verification after apply failed/);
    });
  } finally {
    mock.behaviour.ignoreSettingsKey = null;
  }
  assert.deepEqual(normalisedState(mock.store), before);
});

test("the automatic rollback of a preview leaves changes others made meanwhile alone", async () => {
  writeSet("trial", { settings: { theme_primary_color: "#00ff00" } });
  // A helper that, while the preview design is live, plays "admin changes something else in the admin UI".
  const helper = fakePython('input=$(cat)\necho \'{"ok":true,"count":0,"shots":[],"problems":[]}\'');
  const realShot = sets.screenshot.bind(sets);
  sets.screenshot = async (o) => {
    mock.store.set("forum_title", "Changed by admin");
    mock.store.set("flarum-tags.max_primary_tags", "3");
    return realShot(o);
  };
  try {
    await withPython(helper, () => sets.preview("trial", { confirm: true }));
  } finally {
    sets.screenshot = realShot;
  }
  assert.equal(mock.store.get("theme_primary_color"), "#4D698E", "the preview itself was undone");
  assert.equal(mock.store.get("forum_title"), "Changed by admin");
  assert.equal(mock.store.get("flarum-tags.max_primary_tags"), "3");
});

test("a preview over an applied set restores that set's original logo file and keeps the marker in sync", async () => {
  const original = pngBytes(400, 100);
  writeSet("a", { images: { logo: "images/logo.png" } }, { "images/logo.png": original });
  writeSet("b", { images: { logo: "images/logo.png" } }, { "images/logo.png": pngBytes(500, 120) });
  await sets.apply("a", { confirm: true });
  // Simulate Flarum's lossy re-encode: the live file differs from the set's source.
  writeFileSync(join(root, "public", "assets", mock.store.get("logo_path")), pngBytes(399, 99));
  await withPython(fakePython('input=$(cat)\necho \'{"ok":true,"count":0,"shots":[],"problems":[]}\''), () => sets.preview("b", { confirm: true }));
  const live = readFileSync(join(root, "public", "assets", mock.store.get("logo_path")));
  assert.deepEqual(live, original, "the set's source file was uploaded, not the re-encoded live copy");
  assert.equal((await sets.doctor()).drift, undefined, "no false drift after the preview");
  assert.equal((await sets.plan("a")).images.find((i) => i.kind === "logo").action, "keep");
});

test("a request that throws during rollback (timeout, connection lost) does not stop the other stages", async () => {
  writeSet("full", { settings: { theme_primary_color: "#111111" }, images: { logo: "images/l.png" }, tags: { general: { color: "#123456" } } }, { "images/l.png": pngBytes(400, 100) });
  const applied = await sets.apply("full", { confirm: true });
  const realRaw = sets.ops.client.raw.bind(sets.ops.client);
  sets.ops.client.raw = async (req) => {
    if (req.method === "POST" && req.path === "/settings") throw new Error("Flarum API POST /settings timed out after 300000 ms.");
    return realRaw(req);
  };
  try {
    await assert.rejects(() => sets.rollback(applied.snapshot, { confirm: true }), /rollback incomplete[\s\S]*restore settings failed: .*timed out/);
  } finally {
    sets.ops.client.raw = realRaw;
  }
  assert.equal(mock.store.get("logo_path") ?? null, null, "images were still restored");
  assert.equal(mock.tags.get("1").color, "#888", "tags were still restored");
  assert.equal(mock.store.get("theme_primary_color"), "#111111", "only the failed stage is left");
});

test("plan shows raw HTML in full, and SVGs with script are not published", async () => {
  const long = "<p>" + "x".repeat(300) + "</p><script>steal()</script>";
  writeSet("html", { header: "h.html" }, { "h.html": long, "static/ok.svg": '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', "static/bad.svg": '<svg xmlns="http://www.w3.org/2000/svg" onload="steal()"/>' });
  const plan = await sets.plan("html");
  assert.equal(plan.settings.find((x) => x.key === "custom_header").to, long);
  assert.ok(plan.issues.some((i) => i.key === "static/bad.svg" && i.level === "error"));
  assert.equal(plan.issues.some((i) => i.key === "static/ok.svg"), false);
});

test("an interrupt during apply aborts the running write and rolls back at once, not after every remaining step", async () => {
  const before = normalisedState(mock.store);
  writeSet("slowset", { settings: { theme_primary_color: "#111111" }, images: { logo: "images/l.png" } }, { "images/l.png": pngBytes(400, 100) });
  const saved = process.env.FLARUM2_OPS_LATE_WRITE_WAIT_MS;
  process.env.FLARUM2_OPS_LATE_WRITE_WAIT_MS = "1200";
  mock.behaviour.slowSettingsMs = 800; // the settings POST hangs; the interrupt arrives meanwhile
  const realRaw = sets.ops.client.raw.bind(sets.ops.client);
  let posted = false;
  sets.ops.client.raw = async (req) => {
    if (req.method === "POST" && req.path === "/settings" && !posted) {
      posted = true;
      setTimeout(() => interruptWrites(), 100);
      const p = realRaw(req);
      return p.finally(() => (mock.behaviour.slowSettingsMs = 0));
    }
    return realRaw(req);
  };
  const t0 = Date.now();
  try {
    await assert.rejects(() => sets.apply("slowset", { confirm: true }), /interrupted by a signal/);
  } finally {
    sets.ops.client.raw = realRaw;
    mock.behaviour.slowSettingsMs = 0;
    if (saved === undefined) delete process.env.FLARUM2_OPS_LATE_WRITE_WAIT_MS;
    else process.env.FLARUM2_OPS_LATE_WRITE_WAIT_MS = saved;
  }
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(mock.requests.some((r) => r.method === "POST" && r.path === "/api/logo"), false, "no step after the interrupt ran");
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(normalisedState(mock.store), before, "also the late-landing settings write was undone");
});

// ------------------------------------------------------------- safety/misc

test("a live lock held by another process blocks concurrent writes", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" } });
  mkdirSync(join(root, "design-sets"), { recursive: true });
  writeFileSync(join(root, "design-sets", ".lock"), `${process.ppid} ${new Date().toISOString()}\n`);
  await assert.rejects(() => sets.apply("slate", { confirm: true }), /another design-set write is running/);
});

test("two concurrent writes in the same process: one is refused, the other completes", async () => {
  writeSet("a", { settings: { theme_primary_color: "#111111" } });
  writeSet("b", { settings: { theme_primary_color: "#222222" } });
  const results = await Promise.allSettled([sets.apply("a", { confirm: true }), makeSets().apply("b", { confirm: true })]);
  const won = results.findIndex((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.notEqual(won, -1, String(results.map((r) => r.reason)));
  assert.equal(lost.length, 1);
  assert.match(String(lost[0].reason), /another design-set write is running/);
  assert.equal(mock.store.get("theme_primary_color"), won === 0 ? "#111111" : "#222222");
  assert.equal(existsSync(join(root, "design-sets", ".lock")), false, "lock released");
});

test("a stale lock (dead pid) is taken over", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" } });
  mkdirSync(join(root, "design-sets"), { recursive: true });
  writeFileSync(join(root, "design-sets", ".lock"), "999999999 2026-01-01T00:00:00Z\n");
  await sets.apply("slate", { confirm: true });
  assert.equal(mock.store.get("theme_primary_color"), "#334155");
});

test("a lock owned by a live process of another user (EPERM) is respected, not taken over", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" } });
  mkdirSync(join(root, "design-sets"), { recursive: true });
  // pid 1 always exists; as a normal user kill(1, 0) fails with EPERM (as root it succeeds): alive either way.
  const stamp = `1 ${new Date().toISOString()}\n`;
  writeFileSync(join(root, "design-sets", ".lock"), stamp);
  await assert.rejects(() => sets.apply("slate", { confirm: true }), /another design-set write is running/);
  assert.equal(readFileSync(join(root, "design-sets", ".lock"), "utf8"), stamp);
});

test("taking over a stale lock leaves no stray files behind", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" } });
  mkdirSync(join(root, "design-sets"), { recursive: true });
  writeFileSync(join(root, "design-sets", ".lock"), "999999999 2026-01-01T00:00:00Z\n");
  await sets.apply("slate", { confirm: true });
  assert.deepEqual(readdirSync(join(root, "design-sets")).filter((f) => f.startsWith(".lock")), []);
});

test("a lock from another host or container is never taken over (separate pid namespaces)", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" } });
  mkdirSync(join(root, "design-sets"), { recursive: true });
  const stamp = "999999999 2026-01-01T00:00:00Z some-other-container\n"; // that pid is dead *here*
  writeFileSync(join(root, "design-sets", ".lock"), stamp);
  await assert.rejects(() => sets.apply("slate", { confirm: true }), /another design-set write is running[\s\S]*delete that lock file/);
  assert.equal(readFileSync(join(root, "design-sets", ".lock"), "utf8"), stamp);
  assert.ok((await sets.doctor()).problems.some((p) => /another host or container \(some-other-container\)/.test(p)));
});

test("releasing the lock leaves a lock alone that another process took meanwhile", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" } });
  const lockFile = join(root, "design-sets", ".lock");
  const foreign = `${process.ppid} ${new Date().toISOString()}\n`;
  const realRequest = sets.ops.client.raw.bind(sets.ops.client);
  let swapped = false;
  sets.ops.client.raw = async (req) => {
    if (!swapped && existsSync(lockFile)) {
      swapped = true; // someone deleted our lock by hand and another process took it
      writeFileSync(lockFile, foreign);
    }
    return realRequest(req);
  };
  await sets.apply("slate", { confirm: true });
  assert.equal(swapped, true);
  assert.equal(readFileSync(lockFile, "utf8"), foreign);
});

test("taking over the stale lock of an interrupted write keeps it visible until a rollback resolves it", async () => {
  mkdirSync(join(root, "design-sets"), { recursive: true });
  const since = new Date(Date.now() - 1000).toISOString();
  writeFileSync(join(root, "design-sets", ".lock"), `999999999 ${since}\n`);
  const snap = await sets.snapshot("before-preview-x"); // the interrupted preview's pre-write state
  const res = await sets.ops.settingsSet({ forum_title: "Next write" }, { confirm: true }); // takes the lock over
  assert.match(res.warning, /stale lock of an interrupted design-set write/);
  let d = await sets.doctor();
  assert.ok(d.problems.some((p) => /interrupted design-set write/.test(p) && p.includes(snap.id)), JSON.stringify(d.problems));
  await sets.rollback(snap.id, { confirm: true });
  d = await sets.doctor();
  assert.equal(d.problems.some((p) => /interrupted/.test(p)), false);
});

test("a lock from before the last boot is stale even if its pid now belongs to a live process", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" } });
  mkdirSync(join(root, "design-sets"), { recursive: true });
  const { uptime } = await import("node:os");
  const beforeBoot = new Date(Date.now() - uptime() * 1000 - 3600_000).toISOString();
  writeFileSync(join(root, "design-sets", ".lock"), `1 ${beforeBoot}\n`); // pid 1 is alive, but not the lock holder
  await sets.apply("slate", { confirm: true });
  assert.equal(mock.store.get("theme_primary_color"), "#334155");
});

test("an apply that took over a stale lock keeps the interrupted-write record; a confirmed rollback clears it", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" } });
  mkdirSync(join(root, "design-sets"), { recursive: true });
  writeFileSync(join(root, "design-sets", ".lock"), `999999999 ${new Date().toISOString()}\n`);
  const res = await sets.apply("slate", { confirm: true });
  assert.match(res.warning, /stale lock/);
  assert.ok((await sets.doctor()).problems.some((p) => /interrupted design-set write/.test(p)));
  await sets.rollback(res.snapshot, { confirm: true });
  assert.equal((await sets.doctor()).problems.some((p) => /interrupted/.test(p)), false);
});

test("housekeeping errors after a verified apply do not roll it back", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" } });
  const realPrune = sets.pruneStatic;
  sets.pruneStatic = () => {
    throw new Error("EACCES: permission denied, rmdir 'deadbeef'");
  };
  try {
    const res = await sets.apply("slate", { confirm: true });
    assert.equal(mock.store.get("theme_primary_color"), "#334155", "still applied");
    assert.ok(res.warnings.some((w) => /could not be removed/.test(w)));
  } finally {
    sets.pruneStatic = realPrune;
  }
});

test("an unreadable storage/logs is a health warning, not an exception", async () => {
  mkdirSync(join(root, "storage", "logs"), { recursive: true });
  chmodSync(join(root, "storage", "logs"), 0o000);
  try {
    const h = await sets.ops.health();
    assert.ok((h.warnings ?? []).some((w) => /unreadable/.test(w)), JSON.stringify(h));
  } finally {
    chmodSync(join(root, "storage", "logs"), 0o755);
  }
});

test("a rollback re-upload that stores nothing is reported, not recorded as restored", async () => {
  writeSet("a", { images: { logo: "images/l.png" } }, { "images/l.png": pngBytes(400, 100) });
  writeSet("b", { images: { logo: "images/l.png" } }, { "images/l.png": pngBytes(500, 120) });
  await sets.apply("a", { confirm: true });
  const b = await sets.apply("b", { confirm: true });
  mock.behaviour.ignoreUpload = true;
  try {
    await assert.rejects(() => sets.rollback(b.snapshot, { confirm: true }), /restoring logo: Flarum answered 200 but logo_path did not change/);
  } finally {
    mock.behaviour.ignoreUpload = false;
  }
  assert.equal(existsSync(join(sets.snapshotsDir, b.snapshot, "restored.json")), false);
});

test("doctor reports drift when the live design was changed outside the set", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" } });
  await sets.apply("slate", { confirm: true });
  assert.equal((await sets.doctor()).drift, undefined);
  mock.store.set("theme_primary_color", "#FF0000"); // e.g. edited in the admin UI
  const d = await sets.doctor();
  assert.deepEqual(d.drift, ["theme_primary_color"]);
  assert.equal(d.ok, false);
});

test("export captures the live design as a new, valid set", async () => {
  mock.store.set("custom_less", ".live{color:green}");
  const res = await sets.exportLive("live-copy");
  assert.equal(readFileSync(join(res.exported, "custom.less"), "utf8"), ".live{color:green}");
  assert.equal(res.set.header, "header.html");
  const v = await sets.validate("live-copy");
  assert.equal(v.ok, true, JSON.stringify(v.issues));
});

test("export of a tag with an empty color and a description round-trips through validate and apply", async () => {
  const tag = mock.tags.get("1");
  tag.color = "";
  tag.description = "Talk about anything";
  const res = await sets.exportLive("tag-copy");
  assert.equal("color" in res.set.tags.general, false);
  assert.equal(res.set.tags.general.description, "Talk about anything");
  const v = await sets.validate("tag-copy");
  assert.equal(v.ok, true, JSON.stringify(v.issues));
  const plan = await sets.plan("tag-copy");
  assert.deepEqual(plan.tags, []);
  await sets.apply("tag-copy", { confirm: true });
  assert.equal(mock.tags.get("1").color, "");
});

test("rollback never writes Flarum-managed keys from a tampered snapshot.json", async () => {
  const snap = await sets.snapshot("before-apply-x");
  const file = join(sets.snapshotsDir, snap.id, "snapshot.json");
  const json = JSON.parse(readFileSync(file, "utf8"));
  json.settings.extensions_enabled = { state: "value", value: "[]" };
  json.settings.version = { state: "value", value: "0.0.1" };
  json.settingKeys.push("extensions_enabled", "version");
  writeFileSync(file, JSON.stringify(json));
  const dry = await sets.rollback(snap.id);
  assert.equal(JSON.stringify(dry).includes("extensions_enabled"), false);
  await sets.rollback(snap.id, { confirm: true });
  assert.equal(mock.store.get("extensions_enabled"), JSON.stringify(["flarum-tags"]));
  assert.equal(mock.store.has("version"), false);
});

test("gallery only puts hex colours into style attributes", async () => {
  writeSet("inj", { settings: { theme_primary_color: "red;background:url(//evil.example/x)" } });
  const html = readFileSync(sets.gallery().file, "utf8");
  assert.ok(html.includes("<small>inj</small>"), "the set is listed");
  assert.equal(html.includes("evil.example"), false);
});

test("prune-snapshots is a dry run by default, keeps the newest N and the applied set's snapshot", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" } });
  const applied = await sets.apply("slate", { confirm: true }); // its snapshot is pinned by the marker
  for (let i = 0; i < 5; i++) await sets.snapshot(`manual-${i}`);
  assert.equal(sets.listSnapshots().length, 6);
  const dry = await sets.pruneSnapshots({ keep: 2 });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.wouldDelete.length, 3);
  assert.equal(dry.wouldDelete.some((s) => s.id === applied.snapshot), false);
  assert.equal(sets.listSnapshots().length, 6, "dry run deletes nothing");
  const res = await sets.pruneSnapshots({ keep: 2, confirm: true });
  assert.equal(res.deleted.length, 3);
  const left = sets.listSnapshots().map((s) => s.id);
  assert.equal(left.length, 3);
  assert.ok(left.includes(applied.snapshot), "the applied set's snapshot survives");
  await sets.rollback(applied.snapshot, { confirm: true }); // and still works
  assert.equal(mock.store.get("theme_primary_color"), "#4D698E");
  await assert.rejects(() => sets.pruneSnapshots({ keep: 0 }), /at least 1/);
});

test("manual snapshots and exports wait for no half-applied state: they are refused while a write holds the lock", async () => {
  mkdirSync(join(root, "design-sets"), { recursive: true });
  writeFileSync(join(root, "design-sets", ".lock"), `${process.ppid} ${new Date().toISOString()}\n`);
  await assert.rejects(() => sets.manualSnapshot("manual"), /another design-set write is running/);
  await assert.rejects(() => sets.exportLive("copy"), /another design-set write is running/);
  assert.equal(sets.listSnapshots().length, 0);
});

test("snapshots and the marker belong to one forum when two configs share the design-sets folder", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" } });
  const applied = await sets.apply("slate", { confirm: true });
  // Second forum config, same design-sets folder (e.g. staging + production).
  const other = await startMockFlarum({ forumRoot: makeForumRoot() });
  try {
    const cfg = { name: "b", baseUrl: other.base, forumRoot: root, tokenFile: "/x", designSetsDir: join(root, "design-sets"), publicAssetsSubdir: "design-sets", services: [], repoRoot: root, source: "t" };
    const setsB = new DesignSets(new Ops(cfg, new FlarumClient({ baseUrl: other.base, apiKey: ADMIN_TOKEN }), other.settingsStore));
    assert.throws(() => setsB.loadSnapshot(), /no pre-write snapshot/, "A's snapshots are not B's default");
    await assert.rejects(() => setsB.rollback(applied.snapshot, { confirm: true }), /was taken of .* not of /);
    assert.equal(setsB.marker(), null, "A's marker does not count as applied on B");
    const dry = await setsB.rollback(applied.snapshot, { allowOtherForum: true });
    assert.equal(dry.forum, mock.base);
  } finally {
    await other.close();
  }
});

test("another forum's writes never delete or overwrite this forum's marker; prune keeps other forums' snapshots", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" } });
  await sets.apply("slate", { confirm: true });
  const other = await startMockFlarum({ forumRoot: makeForumRoot() });
  try {
    const cfg = { name: "b", baseUrl: other.base, forumRoot: root, tokenFile: "/x", designSetsDir: join(root, "design-sets"), publicAssetsSubdir: "design-sets", services: [], repoRoot: root, source: "t" };
    const setsB = new DesignSets(new Ops(cfg, new FlarumClient({ baseUrl: other.base, apiKey: ADMIN_TOKEN }), other.settingsStore));
    await setsB.ops.settingsSet({ forum_title: "B" }, { confirm: true });
    const snapB = setsB.listSnapshots().find((x) => x.forum === other.base);
    await setsB.rollback(snapB.id, { confirm: true }); // B's marker is null: must not touch A's
    assert.equal(sets.marker()?.set, "slate", "A's marker survives B's rollback");
    await setsB.pruneSnapshots({ keep: 1, confirm: true });
    assert.ok(sets.listSnapshots().some((x) => x.forum === mock.base), "A's snapshots survive B's prune");
  } finally {
    await other.close();
  }
});

test("a second rollback to the same snapshot keeps the marker pointing at the live image", async () => {
  writeSet("x", { images: { logo: "images/l.png" } }, { "images/l.png": pngBytes(400, 100) });
  writeSet("y", { images: { logo: "images/l.png" } }, { "images/l.png": pngBytes(500, 120) });
  await sets.apply("x", { confirm: true });
  const y = await sets.apply("y", { confirm: true });
  await sets.rollback(y.snapshot, { confirm: true });
  await sets.ops.settingsSet({ forum_title: "in between" }, { confirm: true });
  await sets.rollback(y.snapshot, { confirm: true });
  assert.equal((await sets.doctor()).drift, undefined);
  assert.equal((await sets.plan("x")).images.find((i) => i.kind === "logo").action, "keep");
});

test("after a preview, rollback without an id still means 'undo the last apply'", async () => {
  writeSet("x", { settings: { theme_primary_color: "#111111" } });
  writeSet("y", { settings: { theme_primary_color: "#222222" } });
  const applied = await sets.apply("x", { confirm: true });
  await withPython(fakePython('input=$(cat)\necho \'{"ok":true,"count":0,"shots":[],"problems":[]}\''), () => sets.preview("y", { confirm: true }));
  assert.equal((await sets.rollback(undefined)).snapshot, applied.snapshot);
});

test("a snapshot.json whose id does not match its folder is refused", async () => {
  const snap = await sets.snapshot("before-apply-z");
  const file = join(sets.snapshotsDir, snap.id, "snapshot.json");
  const json = JSON.parse(readFileSync(file, "utf8"));
  json.id = "../../elsewhere";
  writeFileSync(file, JSON.stringify(json));
  assert.throws(() => sets.loadSnapshot(snap.id), /does not match its folder/);
});

test("rollback restores protected keys from a snapshot only with allowProtected", async () => {
  mock.store.set("maintenance_mode", "none");
  const snap = await sets.snapshot("before-apply-m", ["maintenance_mode"]);
  mock.store.set("maintenance_mode", "high");
  const dry = await sets.rollback(snap.id);
  assert.deepEqual(dry.skippedProtected, ["maintenance_mode"]);
  await sets.rollback(snap.id, { confirm: true });
  assert.equal(mock.store.get("maintenance_mode"), "high", "skipped without allowProtected");
  await sets.rollback(snap.id, { confirm: true, allowProtected: true });
  assert.equal(mock.store.get("maintenance_mode"), "none");
});

test("in HTML, a placeholder after ' // ' is resolved (// is not an HTML comment)", async () => {
  writeSet("h", { footer: "f.html" }, { "f.html": '<p>A // <img src="@@ASSET:img/x.png@@"></p>', "static/img/x.png": pngBytes() });
  const plan = await sets.plan("h");
  const footer = plan.settings.find((x) => x.key === "custom_footer").to;
  assert.match(footer, /\/assets\/design-sets\/h\/[0-9a-f]{8}\/img\/x\.png/);
});

test("files changed after the plan (during the preview's probe) are checked again under the lock", async () => {
  const before = normalisedState(mock.store);
  const dir = writeSet("late", { settings: { theme_primary_color: "#00ff00" } }, { "static/ok.png": pngBytes() });
  const bad = join(dir, "static", "bad.svg");
  const probe = fakePython(`input=$(cat)\ncase "$input" in *probe*) printf '%s' '<svg onload="steal()"/>' > ${bad}; echo '{"ok":true,"probe":true}';; *) echo '{"ok":true,"count":0,"shots":[],"problems":[]}';; esac`);
  await withPython(probe, async () => {
    await assert.rejects(() => sets.preview("late", { confirm: true }), /set no longer validates[\s\S]*static\/bad\.svg/);
  });
  assert.deepEqual(normalisedState(mock.store), before);
});

test("UTF-16 SVGs are refused (a UTF-8 read would hide any script in them)", async () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<svg onload="x()"/>', "utf16le")]);
  writeSet("u16", {}, { "static/a.svg": utf16 });
  assert.ok((await sets.plan("u16")).issues.some((i) => i.key === "static/a.svg" && /UTF-16/.test(i.message)));
});

test("an existing snapshots folder with loose permissions is tightened to 0700", async () => {
  mkdirSync(sets.snapshotsDir, { recursive: true });
  chmodSync(sets.snapshotsDir, 0o775);
  await sets.snapshot("manual");
  const { statSync } = await import("node:fs");
  assert.equal(statSync(sets.snapshotsDir).mode & 0o777, 0o700);
});

test("crash leftovers are cleaned up: snapshot folders without snapshot.json and half-copied static versions", async () => {
  const { utimesSync } = await import("node:fs");
  const old = new Date(Date.now() - 2 * 3600_000);
  mkdirSync(join(sets.snapshotsDir, "20260101T000000.000Z-broken"), { recursive: true });
  utimesSync(join(sets.snapshotsDir, "20260101T000000.000Z-broken"), old, old);
  const res = await sets.pruneSnapshots({ confirm: true });
  assert.deepEqual(res.removedBroken, ["20260101T000000.000Z-broken"]);
  const dir = writeSet("s", { less: "c.less" }, { "c.less": "@font-face{src:url('@@ASSET:f.woff2@@')}", "static/f.woff2": "X" });
  void dir;
  const tmp = join(root, "public", "assets", "design-sets", "s", `deadbeef.tmp-1-${Date.now() - 2 * 3600_000}`);
  mkdirSync(tmp, { recursive: true });
  await sets.apply("s", { confirm: true });
  assert.equal(existsSync(tmp), false);
});

test("apply reports health warnings (new log errors) in its result", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" } });
  const real = sets.ops.health.bind(sets.ops);
  sets.ops.health = async (since) => ({ ...(await real(since)), warnings: ["1 error line(s) in storage/logs since x"], logErrors: [{ line: "flarum.ERROR: boom" }] });
  try {
    const res = await sets.apply("slate", { confirm: true });
    assert.ok(res.warnings.some((w) => /error line/.test(w)));
    assert.equal(res.steps.find((x) => x.step === "health").detail.logErrors.length, 1);
  } finally {
    sets.ops.health = real;
  }
});

test("a manual snapshot named before-… never becomes the default rollback target", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" } });
  const applied = await sets.apply("slate", { confirm: true });
  const manual = await sets.manualSnapshot("before-big-experiment");
  assert.match(manual.reason, /^manual-before-/);
  assert.equal((await sets.rollback(undefined)).snapshot, applied.snapshot);
});

test("prune-snapshots keeps 20 by default", async () => {
  for (let i = 0; i < 22; i++) await sets.snapshot(`before-apply-n${i}`);
  const res = await sets.pruneSnapshots({});
  assert.equal(res.remaining ?? res.keep ?? 20, 20, JSON.stringify(res));
  assert.equal((res.wouldDelete ?? res.deleted ?? []).length, 2, JSON.stringify(res));
});

test("a changed static file content gives a new static version", async () => {
  writeSet("v", { less: "c.less" }, { "c.less": "@font-face{src:url('@@ASSET:f.woff2@@')}", "static/f.woff2": "A" });
  const url = (p) => p.settings.find((x) => x.key === "custom_less").to;
  const first = url(await sets.plan("v"));
  writeFileSync(join(root, "design-sets", "v", "static", "f.woff2"), "B");
  assert.notEqual(url(await sets.plan("v")), first);
});

test("screenshot pages with '@' (user-info host switch) are refused", () => {
  assert.throws(() => checkScreenshotOpts({ pages: ["/@169.254.169.254/"] }), /not a forum path/);
});

test("a confirmed rollback with a non-admin token is refused before anything is written", async () => {
  const snap = await sets.snapshot("before-apply-z");
  mock.store.set("theme_primary_color", "#999999");
  const cfg = { name: "m", baseUrl: mock.base, forumRoot: root, tokenFile: "/x", designSetsDir: join(root, "design-sets"), publicAssetsSubdir: "design-sets", services: [], repoRoot: root, source: "t" };
  const member = new DesignSets(new Ops(cfg, new FlarumClient({ baseUrl: mock.base, apiKey: MEMBER_TOKEN }), mock.settingsStore));
  await assert.rejects(() => member.rollback(snap.id, { confirm: true }), /admin/);
  assert.equal(mock.store.get("theme_primary_color"), "#999999");
});

test("an apply upload that Flarum answers but does not store fails and rolls back", async () => {
  writeSet("x", { images: { logo: "images/l.png" } }, { "images/l.png": pngBytes(400, 100) });
  await sets.apply("x", { confirm: true });
  writeSet("y", { images: { logo: "images/l.png" } }, { "images/l.png": pngBytes(500, 120) });
  mock.behaviour.ignoreUpload = true;
  try {
    await assert.rejects(() => sets.apply("y", { confirm: true }), /did not change|logo/);
  } finally {
    mock.behaviour.ignoreUpload = false;
  }
});

test("gallery writes an HTML page listing every set", async () => {
  sets.create("one");
  sets.create("two");
  const g = sets.gallery();
  const html = readFileSync(g.file, "utf8");
  assert.equal(g.sets, 2);
  assert.match(html, /designset preview one --confirm/);
  assert.match(html, /<title>Design-set gallery<\/title>/);
});

for (const [sig, code, closeStderr] of [
  ["SIGINT", 130, false],
  ["SIGHUP", 129, false], // terminal / SSH session gone
  ["SIGTERM", 143, true], // MCP host gone: the handler's log line hits a closed pipe (EPIPE)
]) {
  test(`${sig} during a preview${closeStderr ? " with stderr closed" : ""}: the process rolls back first, then exits ${code}`, async () => {
    const { spawn } = await import("node:child_process");
    const { mkdtempSync, readFileSync: rf } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const here = new URL(".", import.meta.url).href;
    const fake = fakePython(HANGS_AFTER_PROBE);
    const result = join(mkdtempSync(join(tmpdir(), "flarum2-ops-sig-")), "final");
    const script = `
      import { mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { FlarumClient } from "${here}../dist/flarum-client.js";
      import { Ops } from "${here}../dist/ops.js";
      import { DesignSets, installInterruptHandling } from "${here}../dist/designset.js";
      import { startMockFlarum, makeForumRoot, ADMIN_TOKEN } from "${here}helpers/mock-flarum.mjs";
      const root = makeForumRoot();
      const mock = await startMockFlarum({ forumRoot: root });
      const cfg = { name: "t", baseUrl: mock.base, forumRoot: root, tokenFile: "/x", designSetsDir: join(root, "design-sets"), publicAssetsSubdir: "design-sets", services: [], repoRoot: root, source: "t" };
      const sets = new DesignSets(new Ops(cfg, new FlarumClient({ baseUrl: mock.base, apiKey: ADMIN_TOKEN }), mock.settingsStore));
      mkdirSync(join(root, "design-sets", "trial"), { recursive: true });
      writeFileSync(join(root, "design-sets", "trial", "set.json"), JSON.stringify({ name: "trial", title: "t", settings: { theme_primary_color: "#00ff00" } }));
      installInterruptHandling((m) => process.stderr.write(m + "\\n"));
      process.on("exit", () => writeFileSync(${JSON.stringify(result)}, String(mock.store.get("theme_primary_color"))));
      sets.preview("trial", { confirm: true }).catch(() => {});
      const t = setInterval(() => { if (mock.store.get("theme_primary_color") === "#00ff00") { clearInterval(t); setTimeout(() => process.stdout.write("READY\\n"), 150); } }, 20);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: cleanEnv({ FLARUM2_OPS_PYTHON: fake }), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const t0 = { at: 0 };
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("READY") && !child.killedOnce) {
        child.killedOnce = true;
        if (closeStderr) child.stderr.destroy();
        t0.at = Date.now();
        child.kill(sig);
      }
    });
    child.stderr.on("data", (d) => (err += d));
    const exit = await new Promise((r) => child.on("close", (c) => r(c)));
    assert.equal(exit, code, err);
    assert.ok(Date.now() - t0.at < 10_000, "the interrupt stopped the helper instead of waiting for it");
    assert.equal(rf(result, "utf8"), "#4D698E", "rolled back before exiting");
  });
}
