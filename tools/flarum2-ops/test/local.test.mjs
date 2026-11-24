import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { logTime, recentLogErrors } from "../dist/local.js";
import { makeForumRoot } from "./helpers/mock-flarum.mjs";
import { cleanEnv } from "./helpers/env.mjs";

test("logTime keeps the offset and treats stamps without one as UTC", () => {
  assert.equal(logTime("2026-11-23T10:00:00", "", "+00:00").toISOString(), "2026-11-23T10:00:00.000Z");
  assert.equal(logTime("2026-11-23T10:00:00", "", "+0200").toISOString(), "2026-11-23T08:00:00.000Z");
  assert.equal(logTime("2026-11-23 10:00:00").toISOString(), "2026-11-23T10:00:00.000Z");
  assert.equal(logTime("2026-11-23T10:00:00", ".123456", "-05:00").toISOString(), "2026-11-23T15:00:00.123Z");
});

test("recentLogErrors compares in UTC regardless of the host time zone", () => {
  // Run in a child process with a non-UTC TZ: new Date() without an offset would shift by 5 h there.
  const root = makeForumRoot();
  mkdirSync(join(root, "storage", "logs"), { recursive: true });
  writeFileSync(
    join(root, "storage", "logs", "flarum-2026-11-23.log"),
    "[2026-11-23T10:00:00+00:00] flarum.ERROR: old error\n[2026-11-23 12:30:00] flarum.ERROR: new error, no offset\n",
  );
  const when = new Date("2026-11-23T13:00:00Z");
  utimesSync(join(root, "storage", "logs", "flarum-2026-11-23.log"), when, when);
  const script = `
    import { recentLogErrors } from ${JSON.stringify(new URL("../dist/local.js", import.meta.url).href)};
    const r = recentLogErrors(${JSON.stringify(root)}, new Date("2026-11-23T12:00:00Z"));
    console.log(JSON.stringify(r.errors.map((e) => e.line)));`;
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: cleanEnv({ TZ: "America/New_York" }), encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), ["[2026-11-23 12:30:00] flarum.ERROR: new error, no offset"]);
  // In-process too (whatever TZ the test runner has).
  assert.equal(recentLogErrors(root, new Date("2026-11-23T12:00:00Z")).errors.length, 1);
});

test("recentLogErrors reads only the tail of a large log and still finds the newest errors", () => {
  const root = makeForumRoot();
  mkdirSync(join(root, "storage", "logs"), { recursive: true });
  const file = join(root, "storage", "logs", "flarum-2026-11-23.log");
  const old = "[2026-11-23T01:00:00+00:00] flarum.ERROR: " + "x".repeat(200) + "\n";
  writeFileSync(file, old.repeat(50) + "[2026-11-23T12:30:00+00:00] flarum.ERROR: the new one\n");
  const when = new Date("2026-11-23T13:00:00Z");
  utimesSync(file, when, when);
  const since = new Date("2026-11-23T00:00:00Z");
  assert.equal(recentLogErrors(root, since, 1000).errors.length, 51);
  const tail = recentLogErrors(root, since, 1000, 600); // only the last 600 bytes
  assert.ok(tail.errors.length >= 1 && tail.errors.length < 5, String(tail.errors.length));
  assert.match(tail.errors.at(-1).line, /the new one/);
  assert.ok(tail.errors.every((e) => e.line.startsWith("[2026-")), "no cut first line");
});
