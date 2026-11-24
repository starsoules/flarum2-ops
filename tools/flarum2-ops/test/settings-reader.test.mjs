// helpers/settings_read.php against a real SQLite database (every read-back and snapshot depends on it).
// Needs PHP with pdo_sqlite; without it the database tests are skipped with a note, the others still run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const READER = fileURLToPath(new URL("../helpers/settings_read.php", import.meta.url));

function phpModules() {
  try {
    return execFileSync("php", ["-m"], { encoding: "utf8" });
  } catch {
    return "";
  }
}
const modules = phpModules();
const noPhp = modules ? false : "php is not installed";
const DatabaseSync = await import("node:sqlite").then((m) => m.DatabaseSync, () => undefined);
// CI sets FLARUM2_OPS_REQUIRE_PDO_SQLITE=1: there a missing pdo_sqlite is a failure, never a silent skip.
const required = process.env.FLARUM2_OPS_REQUIRE_PDO_SQLITE === "1";
const noSqlite =
  noPhp ||
  (/^pdo_sqlite$/m.test(modules) ? false : "PHP has no pdo_sqlite (apt install php-sqlite3)") ||
  (DatabaseSync ? false : "this Node has no node:sqlite");

function forum({ prefix = "", database = "flarum.sqlite", create = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "flarum2-ops-reader-"));
  writeFileSync(join(root, "config.php"), `<?php return ['database' => ['driver' => 'sqlite', 'database' => '${database}', 'prefix' => '${prefix}']];\n`);
  if (create) {
    const db = new DatabaseSync(join(root, database));
    db.exec(`CREATE TABLE "${prefix}settings" ("key" TEXT PRIMARY KEY, "value" TEXT)`);
    db.exec(`CREATE TABLE "${prefix}group_permission" ("group_id" INTEGER, "permission" TEXT)`);
    const ins = db.prepare(`INSERT INTO "${prefix}settings" VALUES (?, ?)`);
    for (const [k, v] of [
      ["custom_less", ".x{color:red}"],
      ["theme_dark_mode", null],
      ["mail_password", "hunter2"],
      ["mail_from", "noreply@example.org"],
      ["flarum-tags.max_primary_tags", "1"],
      ["themeXlookalike", "no"], // matches "theme_%" only if "_" were a LIKE wildcard
    ]) ins.run(k, v);
    db.prepare(`INSERT INTO "${prefix}group_permission" VALUES (?, ?)`).run(3, "viewForum");
    db.close();
  }
  return root;
}

function read(root, req) {
  const r = spawnSync("php", [READER, root], { input: JSON.stringify(req), encoding: "utf8" });
  return { code: r.status, out: JSON.parse(r.stdout) };
}

test("settings reader: pdo_sqlite is available where it is required", { skip: !required }, () => {
  assert.equal(noSqlite, false, `required by FLARUM2_OPS_REQUIRE_PDO_SQLITE: ${noSqlite}`);
});

test("settings reader keeps absent, NULL and value apart and redacts secrets", { skip: noSqlite }, () => {
  const root = forum();
  const { code, out } = read(root, { mode: "get", keys: ["custom_less", "theme_dark_mode", "not_there", "mail_password", "mail_from"] });
  assert.equal(code, 0, JSON.stringify(out));
  assert.deepEqual(out.settings, {
    custom_less: { state: "value", value: ".x{color:red}" },
    mail_from: { state: "value", value: "noreply@example.org" },
    mail_password: { state: "redacted" },
    not_there: { state: "absent" },
    theme_dark_mode: { state: "null" },
  });
  assert.doesNotMatch(JSON.stringify(out), /hunter2/);
});

test("settings reader: a prefix matches literally ('_' is not a LIKE wildcard), with a table prefix", { skip: noSqlite }, () => {
  const root = forum({ prefix: "fl_" });
  const { code, out } = read(root, { mode: "get", prefixes: ["theme_"] });
  assert.equal(code, 0, JSON.stringify(out));
  assert.deepEqual(Object.keys(out.settings), ["theme_dark_mode"]);
});

test("settings reader lists keys with their secret flag and reads permissions", { skip: noSqlite }, () => {
  const root = forum();
  const keys = read(root, { mode: "keys" }).out.keys;
  assert.ok(keys.some((k) => k.key === "mail_password" && k.secret === true));
  assert.ok(keys.some((k) => k.key === "custom_less" && k.secret === false));
  assert.deepEqual(read(root, { mode: "permissions", names: ["viewForum"] }).out.permissions, { viewForum: [3] });
});

test("settings reader never creates a missing SQLite file and rejects unsafe table prefixes", { skip: noPhp }, () => {
  const missing = forum({ create: false });
  const r = read(missing, { mode: "keys" });
  assert.equal(r.code, 1);
  assert.match(r.out.error, /sqlite database file not found/);
  assert.equal(existsSync(join(missing, "flarum.sqlite")), false);
  const bad = forum({ create: false, prefix: "x`; DROP" });
  assert.match(read(bad, { mode: "keys" }).out.error, /unsupported table prefix/);
});
