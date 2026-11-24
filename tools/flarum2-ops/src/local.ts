/**
 * Local-install bridge: things the HTTP API cannot do for a forum on this host.
 *
 *  - readSettings(): full settings read through helpers/settings_read.php
 *    (read-only PDO; Flarum has no settings GET endpoint).
 *  - serviceStates(): `systemctl is-active` for the configured units.
 *  - recentLogErrors(): ERROR/CRITICAL lines in storage/logs/flarum-*.log.
 *
 * Everything here is read-only with respect to the forum.
 */

import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./config.js";

export type SettingState =
  | { state: "absent" }
  | { state: "null" }
  | { state: "redacted" }
  | { state: "value"; value: string };

export type SettingsMap = Record<string, SettingState>;

function run(cmd: string, args: string[], input?: string, timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // php / systemctl never need our credentials.
    const env = { ...process.env };
    delete env.FLARUM_API_KEY;
    delete env.MCP_AUTH_TOKEN;
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: number | string }).code === "ENOENT" ? 127 : typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    if (input !== undefined) {
      child.stdin?.on("error", () => {}); // EPIPE when the child exits early: reported through its exit code
      child.stdin?.end(input);
    }
  });
}

export function settingsHelperPath(): string {
  return join(packageRoot(), "helpers", "settings_read.php");
}

async function helper<T>(forumRoot: string, request: Record<string, unknown>): Promise<T> {
  if (!existsSync(join(forumRoot, "config.php"))) {
    throw new Error(`No config.php in ${forumRoot}; settings reads need a local Flarum install (set forum_root).`);
  }
  const res = await run("php", [settingsHelperPath(), forumRoot], JSON.stringify(request));
  if (res.code === 127) throw new Error("php CLI not found in PATH; it is required for local settings reads.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error(`settings helper returned non-JSON (exit ${res.code}): ${res.stdout.slice(0, 300)}${res.stderr.slice(0, 300)}`);
  }
  const obj = parsed as { error?: string };
  if (obj.error) throw new Error(`settings helper: ${obj.error}`);
  return parsed as T;
}

/** Read settings by exact key and/or key prefix. Secret-looking keys come back as "redacted". */
export async function readSettings(forumRoot: string, keys: string[], prefixes: string[] = []): Promise<SettingsMap> {
  const out = await helper<{ settings: SettingsMap | unknown[] }>(forumRoot, { mode: "get", keys, prefixes });
  // PHP encodes an empty associative array as [].
  return Array.isArray(out.settings) ? {} : (out.settings as SettingsMap);
}

/** All setting key names (no values) with a secret flag. */
export async function listSettingKeys(forumRoot: string): Promise<{ key: string; secret: boolean }[]> {
  const out = await helper<{ keys: { key: string; secret: boolean }[] }>(forumRoot, { mode: "keys" });
  return out.keys;
}

/** Current group ids per permission name. */
export async function readPermissions(forumRoot: string, names: string[]): Promise<Record<string, number[]>> {
  const out = await helper<{ permissions: Record<string, number[]> | unknown[] }>(forumRoot, { mode: "permissions", names });
  return Array.isArray(out.permissions) ? {} : (out.permissions as Record<string, number[]>);
}

/** Value of a setting, or undefined when absent/null/redacted. */
export function valueOf(map: SettingsMap, key: string): string | undefined {
  const s = map[key];
  return s && s.state === "value" ? s.value : undefined;
}

export async function serviceStates(services: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    services.map(async (s) => {
      const r = await run("systemctl", ["is-active", s], undefined, 10_000);
      out[s] = r.code === 127 ? "unknown (no systemctl)" : r.stdout.trim() || (r.code === 0 ? "active" : "inactive");
    }),
  );
  return out;
}

export interface LogError {
  file: string;
  time: string;
  line: string;
}

/**
 * Monolog's default stamp is "Y-m-d\\TH:i:sP" (with offset) and flarum/core's Site.php runs PHP in UTC, so a
 * stamp without an offset is UTC. Never parse it as host-local time.
 */
export function logTime(stamp: string, fraction = "", offset?: string): Date {
  let off = offset ?? "Z";
  if (/^[+-]\d{4}$/.test(off)) off = `${off.slice(0, 3)}:${off.slice(3)}`;
  return new Date(`${stamp.replace(" ", "T")}${(fraction ?? "").slice(0, 4)}${off}`);
}

/**
 * ERROR/CRITICAL/ALERT/EMERGENCY lines from storage/logs/flarum*.log written at
 * or after `since` (ISO string or Date). Lines are truncated to 400 chars.
 */
/** Health checks look for *new* errors, which are at the end of a log: read at most this much of each file. */
export const LOG_TAIL_BYTES = 2 * 1024 * 1024;

/** The last `max` bytes of a file as text, without the (possibly cut) first line when the file is longer. */
function readTail(file: string, max: number): string {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const text = buf.subarray(0, read).toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

export function recentLogErrors(
  forumRoot: string,
  since: Date,
  max = 20,
  tailBytes = LOG_TAIL_BYTES,
): { errors: LogError[]; unreadable: string[] } {
  const dir = join(forumRoot, "storage", "logs");
  const errors: LogError[] = [];
  const unreadable: string[] = [];
  if (!existsSync(dir)) return { errors, unreadable };
  // The log folder often belongs to the web server user, and files rotate between readdir and stat: report what
  // cannot be read instead of throwing (a throw here would fail health and roll a correct apply back).
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    unreadable.push(dir);
    return { errors, unreadable };
  }
  const files = names
    .filter((f) => /^flarum.*\.log$/.test(f) && f !== "flarum-installer.log")
    .map((f) => join(dir, f))
    .filter((f) => {
      try {
        return statSync(f).mtime >= since;
      } catch {
        return false; // rotated away meanwhile
      }
    });
  for (const file of files) {
    let text: string;
    try {
      text = readTail(file, tailBytes); // not the whole file: daily logs of a busy forum can be very large
    } catch {
      unreadable.push(file);
      continue;
    }
    for (const line of text.split("\n")) {
      const m = /^\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?[^\]]*\]\s+\S+\.(ERROR|CRITICAL|ALERT|EMERGENCY):/.exec(line);
      if (!m) continue;
      const t = logTime(m[1], m[2], m[3]);
      if (t >= since) errors.push({ file, time: m[1], line: line.slice(0, 400) });
    }
  }
  return { errors: errors.slice(-max), unreadable };
}
