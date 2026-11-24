/**
 * Admin operations shared by the MCP tools and the CLI.
 *
 * Every mutating operation follows one contract:
 *   - without confirm: a dry run that returns exactly what would be sent
 *     (plus validation issues and the current values), and changes nothing;
 *   - with confirm: performs the write, verifies the result and reports the
 *     HTTP status of every request it made.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { FlarumClient, FlarumError, type FlarumResponse } from "./flarum-client.js";
import type { OpsConfig } from "./config.js";
import { DEFAULT_USER_AGENT } from "./version.js";
import { requireAdmin, whoami, type Actor } from "./auth.js";
import { MAX_UPLOAD_BYTES, checkUpload, kindAdvice } from "./images.js";
import {
  CSS_KEYS,
  IMAGE_KINDS,
  NEEDS_CACHE_CLEAR_KEYS,
  checkSettingsWrite,
  classifyKey,
  writeNeedsCacheClear,
  isSecretKey,
  type ImageKind,
  type ValidationIssue,
} from "./policy.js";
import {
  listSettingKeys,
  readPermissions,
  readSettings,
  recentLogErrors,
  serviceStates,
  valueOf,
  type SettingsMap,
} from "./local.js";

/**
 * Read access to the forum's settings/permissions tables. The default goes
 * through helpers/settings_read.php (read-only PDO); tests inject a fake.
 */
export interface SettingsStore {
  read(keys: string[], prefixes?: string[]): Promise<SettingsMap>;
  listKeys(): Promise<{ key: string; secret: boolean }[]>;
  permissions(names: string[]): Promise<Record<string, number[]>>;
}

export class PhpSettingsStore implements SettingsStore {
  constructor(private readonly forumRoot: string) {}
  read(keys: string[], prefixes: string[] = []) {
    return readSettings(this.forumRoot, keys, prefixes);
  }
  listKeys() {
    return listSettingKeys(this.forumRoot);
  }
  permissions(names: string[]) {
    return readPermissions(this.forumRoot, names);
  }
}

export interface StepResult {
  step: string;
  method?: string;
  path?: string;
  status?: number;
  ok: boolean;
  detail?: unknown;
}

export class OpsError extends Error {
  steps: StepResult[];
  constructor(message: string, steps: StepResult[] = []) {
    super(message);
    this.name = "OpsError";
    this.steps = steps;
  }
}

/**
 * Settings writes run Flarum's trial LESS compile (per locale) before anything is stored, which can take long on a
 * loaded server. A client timeout does not stop the server: the write can still land after we gave up. So wait as
 * long as for a cache clear rather than report a failure that later turns out to be a success.
 */
export function settingsWriteTimeoutMs(): number {
  const v = Number(process.env.FLARUM2_OPS_SETTINGS_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 300_000;
}

/**
 * A confirmed write whose read-back does not match is a failure, not a success with a flag: callers (CLI exit
 * code, MCP isError, cron jobs) must not mistake it for a completed write.
 */
function requireVerified(verify: { ok?: unknown }, steps: StepResult[], what: string, hint?: string): void {
  if (verify.ok === true) return;
  throw new OpsError(
    `${what} was sent, but the read-back does not match (${JSON.stringify(verify)}).${hint ? ` ${hint}` : ""}`,
    [...steps, { step: "verify", ok: false, detail: verify }],
  );
}

/** A cache clear that reports failure after a write: the write stands, but CSS is not rebuilt. */
function requireCacheCleared(step: StepResult, steps: StepResult[]): void {
  if (step.ok) return;
  throw new OpsError("the write succeeded, but the cache clear failed, so CSS was not rebuilt; run `cache clear` again", steps);
}

/** Mask e-mail addresses, IPv4/IPv6 addresses and (when given) a secret in a log line. */
export function maskPersonalData(line: string, secret?: string): string {
  let out = line
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>")
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "<ip>")
    // IPv6: a "::" form or all eight groups (a time such as 10:00:00 has neither).
    .replace(/(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?|\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi, "<ip>");
  if (secret && secret.length >= 6) out = out.split(secret).join("***");
  return out;
}

/** Compact error description of a non-2xx response (JSON:API errors[] when present). */
export function describeFailure(res: FlarumResponse): string {
  const body = res.body as { errors?: { code?: string; detail?: string; source?: { pointer?: string } }[] } | null;
  if (body && Array.isArray(body.errors) && body.errors.length) {
    return body.errors
      .map((e) => [e.code, e.source?.pointer, e.detail].filter(Boolean).join(" "))
      .join("; ");
  }
  return typeof res.body === "string" ? res.body.slice(0, 500) : JSON.stringify(res.body)?.slice(0, 500) ?? "";
}

export class Ops {
  readonly store?: SettingsStore;

  constructor(
    readonly cfg: OpsConfig,
    readonly client: FlarumClient,
    store?: SettingsStore,
  ) {
    this.store = store ?? (cfg.forumRoot ? new PhpSettingsStore(cfg.forumRoot) : undefined);
  }

  /** Settings store; throws a clear error when there is no local install. */
  get db(): SettingsStore {
    if (!this.store) throw new Error("This needs a local install: set forum_root in forum.json (or FLARUM_ROOT).");
    return this.store;
  }

  get local(): boolean {
    return Boolean(this.store);
  }

  /**
   * Runs `fn` under the design-set write lock after a restorable snapshot (design-set format, so
   * `designset rollback <id>` restores it) that also covers `keys`. Installed by DesignSets, which owns the lock
   * and the snapshot format, so settings/image writes never interleave with an apply, preview or rollback.
   */
  writeGuard?: <T>(reason: string, keys: string[], fn: (snapshotId: string) => Promise<T>) => Promise<T>;

  /** The design-set write lock alone (no snapshot), also installed by DesignSets. */
  lockGuard?: <T>(fn: () => Promise<T>) => Promise<T>;

  /**
   * Confirmed write with snapshot + lock. Any failure after the snapshot names it, so a partially applied write
   * can be undone. Without a local install there is nothing to read, so no snapshot (and no lock) is taken.
   */
  private async guardedWrite(
    reason: string,
    keys: string[],
    fn: (snap: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    if (!this.local || !this.writeGuard) {
      return fn({ snapshot: null, snapshotNote: "no pre-write snapshot: needs a local install (forum_root) and the design-set engine" });
    }
    return this.writeGuard(reason, keys, async (id) => {
      try {
        return await fn({ snapshot: id, rollback: `designset rollback ${id}` });
      } catch (e) {
        const err = e as Error & { steps?: StepResult[] };
        throw new OpsError(
          `${err.message} Snapshot taken before this write: ${id}; if anything changed, restore with: designset rollback ${id}`,
          err instanceof OpsError ? err.steps : [],
        );
      }
    });
  }

  // ---------------------------------------------------------------- reads

  async whoami(): Promise<{ actor: Actor; forum: Record<string, unknown> }> {
    return whoami(this.client);
  }

  async enabledExtensions(): Promise<string[]> {
    if (!this.store) return [];
    const raw = valueOf(await this.store.read(["extensions_enabled"]), "extensions_enabled");
    if (!raw) return [];
    try {
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  /**
   * Why the live image at `livePath` could not be restored after it is replaced or deleted (Flarum deletes the old
   * file): not on the local assets disk, so no snapshot copy, or a type Flarum 2 refuses on upload (.ico from 1.x).
   */
  unrestorableImage(livePath: string): string | undefined {
    if (!this.cfg.forumRoot) return "no local install, so no snapshot copy";
    const file = join(this.cfg.forumRoot, "public", "assets", livePath);
    if (!existsSync(file)) return "its file is not on the local assets disk (remote storage?), so no snapshot copy is possible";
    try {
      checkUpload(readFileSync(file), basename(livePath));
      return undefined;
    } catch (e) {
      return `its type cannot be uploaded again (${(e as Error).message})`;
    }
  }

  /** Settings by key/prefix from the database (secret keys redacted). */
  async settingsGet(keys: string[], prefixes: string[] = []): Promise<SettingsMap> {
    return this.db.read(keys, prefixes);
  }

  async customLessError(): Promise<string | undefined> {
    if (!this.store) return undefined;
    return valueOf(await this.store.read(["custom_less_error"]), "custom_less_error");
  }

  /** Health: services, root/API/stylesheet HTTP status, new log errors, custom_less_error. */
  async health(
    since: Date = new Date(Date.now() - 15 * 60_000),
    opts: { timeoutMs?: number } = {},
  ): Promise<Record<string, unknown> & { ok: boolean }> {
    const problems: string[] = [];
    const base = this.client.forumUrl;
    const ua = this.client.agent;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    // Same User-Agent as the API client (WAFs block generic UAs) and a timeout, because apply holds the
    // design-set lock while it waits for this check.
    const fetchStatus = async (url: string) => {
      try {
        // The forum's own User-Agent (maybe a WAF allowlist secret) only to the forum itself, never to a CDN.
        const agent = new URL(url).origin === new URL(`${base}/`).origin ? ua : DEFAULT_USER_AGENT;
        const r = await fetch(url, {
          redirect: "manual",
          headers: agent ? { "User-Agent": agent } : {},
          signal: AbortSignal.timeout(timeoutMs),
        });
        const ct = r.headers.get("content-type") ?? "";
        return { status: r.status, text: /html|json/.test(ct) ? await r.text() : "" };
      } catch (e) {
        return { status: 0, text: "", error: (e as Error).message };
      }
    };
    const root = await fetchStatus(`${base}/`);
    const api = await fetchStatus(`${base}/api`);
    if (root.status !== 200) problems.push(`forum root returned ${root.status}`);
    if (api.status !== 200) problems.push(`API root returned ${api.status}`);

    // Only the forum's own stylesheets decide health: same origin as the forum or as its assets URL (a CDN disk).
    // Third-party CSS (fonts, widgets) is listed but never fetched: it says nothing about this write and its
    // hosts should not be contacted from the server.
    const warnings: string[] = [];
    const ownOrigins = new Set<string>([new URL(`${base}/`).origin]);
    try {
      const assetsBase = (JSON.parse(api.text) as { data?: { attributes?: { assetsBaseUrl?: string } } }).data?.attributes?.assetsBaseUrl;
      if (assetsBase) ownOrigins.add(new URL(assetsBase).origin);
    } catch {
      /* no JSON forum document: forum origin only */
    }
    const assets: Record<string, number> = {};
    const external: string[] = [];
    for (const m of root.text.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)) {
      const href = m[1].replace(/&amp;/g, "&");
      let url: URL;
      try {
        url = new URL(href, `${base}/`); // resolves "/x", "x" and protocol-relative "//host/x" correctly
      } catch {
        problems.push(`stylesheet link ${href} is not a valid URL`);
        continue;
      }
      if (!ownOrigins.has(url.origin)) {
        external.push(href);
        continue;
      }
      const r = await fetchStatus(url.href);
      assets[href] = r.status;
      if (r.status !== 200) problems.push(`stylesheet ${href} returned ${r.status}`);
    }
    if (root.status === 200 && Object.keys(assets).length === 0) problems.push("no stylesheet of the forum itself found in the forum HTML");

    const out: Record<string, unknown> & { ok: boolean } = { ok: false, root: root.status, api: api.status, stylesheets: assets };
    if (external.length) out.externalStylesheets = external;
    if (this.local && this.cfg.forumRoot) {
      out.services = await serviceStates(this.cfg.services);
      for (const [s, st] of Object.entries(out.services as Record<string, string>)) {
        // No systemctl (containers, other init systems): not a forum problem, so it must not roll an apply back.
        if (st.startsWith("unknown")) warnings.push(`service ${s}: ${st}; set "services": [] in forum.json to skip service checks`);
        else if (st !== "active") problems.push(`service ${s} is ${st}`);
      }
      const logs = recentLogErrors(this.cfg.forumRoot, since);
      out.logErrorsSince = since.toISOString();
      // Log lines go to the agent (and its model provider): mask e-mail addresses, IPs and our own credential.
      out.logErrors = logs.errors.map((e) => ({ ...e, line: maskPersonalData(e.line, this.client.credential) }));
      if (logs.unreadable.length) {
        out.unreadableLogs = logs.unreadable;
        warnings.push(`${logs.unreadable.length} log file(s) unreadable: new errors there are not detected`);
      }
      // Owner decision: log errors are a warning, never a reason to roll an apply back. On a busy forum other
      // requests (mail, queue, extensions) log errors at any time; they cannot be told apart from ones the apply
      // caused. They stay visible in logErrors and warnings.
      if (logs.errors.length) warnings.push(`${logs.errors.length} error line(s) in storage/logs since ${since.toISOString()} (see logErrors)`);
    }
    if (this.local) {
      const cle = await this.customLessError();
      if (cle) {
        out.customLessError = cle;
        problems.push("custom_less_error is set: Flarum is silently dropping custom_less until a valid custom_less is saved");
      }
    }
    out.problems = problems;
    if (warnings.length) out.warnings = warnings;
    out.ok = problems.length === 0;
    return out;
  }

  // --------------------------------------------------------------- writes

  /**
   * POST /api/settings. custom_less goes in its own request first so a 422
   * from the trial compile is attributable and nothing else is persisted; on
   * failure the previous custom_less is re-saved, which clears the
   * custom_less_error flag Flarum leaves behind. Without a local install the
   * previous value is unknown, so nothing is re-saved and the error says so.
   */
  async settingsSet(
    values: Record<string, unknown>,
    opts: { confirm?: boolean; allowProtected?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const ext = await this.enabledExtensions();
    const { normalised, issues } = checkSettingsWrite(values, { enabledExtensions: ext, allowProtected: opts.allowProtected });
    const errors = issues.filter((i) => i.level === "error");
    const keys = Object.keys(normalised);
    const current = this.local && keys.length ? await this.db.read(keys) : {};
    const changes = keys.map((k) => ({
      key: k,
      from: isSecretKey(k) ? "***" : summarise(current[k]),
      to: isSecretKey(k) ? "***" : preview(normalised[k]),
    }));
    for (const k of keys) {
      if (isSecretKey(k)) {
        issues.push({ key: k, level: "warning", message: "secret value: snapshots never contain it, so a rollback cannot restore the previous value" });
      }
    }
    if (!opts.confirm || errors.length) {
      return { dryRun: true, wouldSend: changes, issues, blocked: errors.length > 0 };
    }
    await requireAdmin(this.client);
    return this.guardedWrite("before-settings-set", keys, async (snap) => {
      const steps: StepResult[] = [];
      const failed = await this.postSettings(normalised, steps, { less: "custom_less", rest: "settings" });
      if (failed.less) {
        const rejected = `custom_less was rejected (${failed.less.status}): ${describeFailure(failed.less)}. Nothing else was changed.`;
        if (!this.local) {
          // No settings reader: the stored custom_less cannot be read, and re-saving a guess ("") would wipe the
          // forum's LESS. Report instead; Flarum keeps the old value but leaves the flag set.
          throw new OpsError(
            `${rejected} Without a local install the previous custom_less cannot be read, so it was not re-saved: Flarum keeps it, but ` +
              "custom_less_error stays set and custom_less is dropped on every compile until a valid custom_less is saved.",
            steps,
          );
        }
        const restore = await this.resaveCustomLess(steps, "restore previous custom_less (clears custom_less_error)");
        throw new OpsError(
          rejected +
            (restore.ok
              ? ""
              : ` Re-saving the previous custom_less FAILED (${restore.status}): custom_less_error stays set and Flarum drops custom_less on every compile until a valid custom_less is saved.`),
          steps,
        );
      }
      if (failed.rest) throw new OpsError(`settings write failed (${failed.rest.status}): ${describeFailure(failed.rest)}`, steps);
      if (writeNeedsCacheClear(normalised)) {
        const cache = await this.cacheClearStep();
        steps.push(cache);
        requireCacheCleared(cache, steps);
      }
      const verify = await this.verifySettings(normalised);
      requireVerified(verify, steps, "settings write");
      return { dryRun: false, ...snap, steps, issues, verify };
    });
  }

  /**
   * POST /api/settings in the one safe order, for every caller (settings set, design-set apply, rollback):
   * custom_less alone first, so a 422 from Flarum's trial compile is attributable and no other key was persisted,
   * then the remaining keys. Appends one step per request and returns the failed responses. Unless keepGoing,
   * nothing more is sent after a failure.
   */
  async postSettings(
    values: Record<string, string | null>,
    steps: StepResult[],
    names: { less: string; rest: string },
    keepGoing = false,
  ): Promise<{ less?: FlarumResponse; rest?: FlarumResponse }> {
    const failed: { less?: FlarumResponse; rest?: FlarumResponse } = {};
    if ("custom_less" in values) {
      const res = await this.client.raw({ method: "POST", path: "/settings", body: { custom_less: values.custom_less } , timeoutMs: settingsWriteTimeoutMs() });
      steps.push({ step: names.less, method: "POST", path: "/api/settings", status: res.status, ok: res.ok, detail: res.ok ? undefined : describeFailure(res) });
      if (!res.ok) {
        failed.less = res;
        if (!keepGoing) return failed;
      }
    }
    const rest = Object.fromEntries(Object.entries(values).filter(([k]) => k !== "custom_less"));
    if (Object.keys(rest).length) {
      const res = await this.client.raw({ method: "POST", path: "/settings", body: rest , timeoutMs: settingsWriteTimeoutMs() });
      steps.push({ step: names.rest, method: "POST", path: "/api/settings", status: res.status, ok: res.ok, detail: res.ok ? Object.keys(rest) : describeFailure(res) });
      if (!res.ok) failed.rest = res;
    }
    return failed;
  }

  /**
   * Re-save the stored custom_less. A rejected save leaves custom_less_error behind although the stored value never
   * changed, and Flarum then drops custom_less on every compile; only a valid save clears the flag. Needs a local
   * install (the stored value must be read, never guessed).
   */
  async resaveCustomLess(steps: StepResult[], step: string): Promise<FlarumResponse> {
    const stored = valueOf(await this.db.read(["custom_less"]), "custom_less") ?? "";
    const res = await this.client.raw({ method: "POST", path: "/settings", body: { custom_less: stored } , timeoutMs: settingsWriteTimeoutMs() });
    steps.push({ step, method: "POST", path: "/api/settings", status: res.status, ok: res.ok, detail: res.ok ? undefined : describeFailure(res) });
    return res;
  }

  /** Compare stored values with what was written (secret keys are skipped: their values are never read). */
  async verifySettings(expected: Record<string, string | null>): Promise<{ ok: boolean; mismatches: unknown[]; customLessError?: string; skipped?: string }> {
    // Nothing can be read back without a local install: say so instead of reporting a check that did not happen.
    if (!this.local) return { ok: true, mismatches: [], skipped: "no local install (forum_root): not verified" };
    const keys = Object.keys(expected);
    const now = await this.db.read([...keys, "custom_less_error"]);
    const mismatches: unknown[] = [];
    for (const k of keys) {
      const want = expected[k];
      const got = now[k];
      if (isSecretKey(k)) continue;
      const okValue = want === null ? got?.state === "null" : got?.state === "value" && got.value === want;
      if (!okValue) mismatches.push({ key: k, expected: preview(want), actual: summarise(got) });
    }
    const cle = valueOf(now, "custom_less_error");
    return { ok: mismatches.length === 0 && !cle, mismatches, ...(cle ? { customLessError: cle } : {}) };
  }

  /** Read-back after a reset: every key must be gone (Flarum then uses its default). */
  async verifyAbsent(keys: string[]): Promise<{ ok: boolean; mismatches: unknown[]; skipped?: string }> {
    // Nothing can be read back without a local install: say so instead of reporting a check that did not happen.
    if (!this.local) return { ok: true, mismatches: [], skipped: "no local install (forum_root): not verified" };
    const now = await this.db.read(keys);
    const mismatches = keys.filter((k) => now[k] && now[k].state !== "absent").map((k) => ({ key: k, expected: "(absent)", actual: summarise(now[k]) }));
    return { ok: mismatches.length === 0, mismatches };
  }

  /** DELETE /api/settings {keys}: back to Flarum's defaults. Clears the cache when CSS is affected. */
  async settingsReset(keys: string[], opts: { confirm?: boolean; allowProtected?: boolean } = {}): Promise<Record<string, unknown>> {
    if (!keys.length) throw new Error("settings reset needs at least one key");
    // Same policy as settingsSet: Flarum-managed keys never, protected keys only with allowProtected.
    const ext = await this.enabledExtensions();
    const issues: ValidationIssue[] = [];
    for (const k of keys) {
      const cls = classifyKey(k, ext);
      if (cls === "forbidden") issues.push({ key: k, level: "error", message: "managed by Flarum itself (or not a valid key); it cannot be reset here" });
      else if (cls === "protected" && !opts.allowProtected) {
        issues.push({ key: k, level: "error", message: "protected key (mail, maintenance, drivers, secrets): needs allowProtected and the user's explicit approval" });
      }
      if (isSecretKey(k)) {
        issues.push({ key: k, level: "warning", message: "secret value: snapshots never contain it, so this reset cannot be undone by a rollback" });
      }
    }
    const blocked = issues.filter((i) => i.level === "error").map((i) => i.key);
    if (!opts.confirm || blocked.length) {
      const current = this.local ? await this.db.read(keys) : {};
      return {
        dryRun: true,
        wouldDelete: keys.map((k) => ({ key: k, current: isSecretKey(k) ? "***" : summarise(current[k]) })),
        blocked,
        issues,
        note: "DELETE /api/settings does not trigger a CSS rebuild; a cache clear follows automatically when CSS keys are reset.",
      };
    }
    await requireAdmin(this.client);
    return this.guardedWrite("before-settings-reset", keys, async (snap) => {
      const steps: StepResult[] = [];
      const res = await this.client.raw({ method: "DELETE", path: "/settings", body: { keys } , timeoutMs: settingsWriteTimeoutMs() });
      steps.push({ step: "reset", method: "DELETE", path: "/api/settings", status: res.status, ok: res.ok, detail: res.ok ? keys : describeFailure(res) });
      if (!res.ok) throw new OpsError(`settings reset failed (${res.status}): ${describeFailure(res)}`, steps);
      if (keys.some((k) => CSS_KEYS.includes(k) || NEEDS_CACHE_CLEAR_KEYS.includes(k))) {
        const cache = await this.cacheClearStep();
        steps.push(cache);
        requireCacheCleared(cache, steps);
      }
      const verify = await this.verifyAbsent(keys);
      requireVerified(verify, steps, "settings reset");
      return { dryRun: false, ...snap, steps, verify };
    });
  }

  /** DELETE /api/cache, parsing the NDJSON progress stream Flarum 2 returns. */
  async cacheClear(opts: { confirm?: boolean } = {}): Promise<Record<string, unknown>> {
    if (!opts.confirm) {
      return {
        dryRun: true,
        note: "Clears the cache store (also resets login throttles), deletes storage/formatter, locale and views, and rebuilds every asset bundle. Takes seconds; not destructive.",
      };
    }
    await requireAdmin(this.client);
    const step = await this.cacheClearStep();
    if (!step.ok) throw new OpsError("cache clear reported a failure", [step]);
    return { dryRun: false, steps: [step] };
  }

  async cacheClearStep(): Promise<StepResult> {
    const res = await this.client.raw({ method: "DELETE", path: "/cache", timeoutMs: 300_000 });
    const lines = Array.isArray(res.body) ? (res.body as Record<string, unknown>[]) : [];
    const failed = lines.filter((l) => l.type === "failed" || l.status === "failed" || l.error);
    // ClearCacheController ends the stream with {"type":"done"} so a client can tell completion from a dropped
    // connection (PHP timeout or fatal mid-rebuild); a 200 without it is not a finished cache clear.
    const done = lines.some((l) => l.type === "done");
    return {
      step: "cache clear",
      method: "DELETE",
      path: "/api/cache",
      status: res.status,
      ok: res.ok && failed.length === 0 && done,
      detail: failed.length ? failed : done ? { events: lines.length } : { events: lines.length, error: "stream ended without the final done event" },
    };
  }

  async uploadImage(kind: ImageKind, file: string, opts: { confirm?: boolean } = {}): Promise<Record<string, unknown>> {
    const spec = IMAGE_KINDS[kind];
    if (!spec) throw new Error(`unknown image kind "${kind}" (use ${Object.keys(IMAGE_KINDS).join(", ")})`);
    // Check before reading: the path comes from the agent; a FIFO or device would block or exhaust memory.
    const st = statSync(file);
    if (!st.isFile()) throw new Error(`${file} is not a regular file`);
    if (st.size > MAX_UPLOAD_BYTES) throw new Error(`${basename(file)} is ${(st.size / 1024).toFixed(0)} KB; Flarum accepts at most 2048 KB.`);
    const data = readFileSync(file);
    const { info } = checkUpload(data, basename(file));
    const advice = kindAdvice(kind, info);
    const previous = this.local ? valueOf(await this.db.read([spec.pathKey]), spec.pathKey) : undefined;
    const lost = previous ? this.unrestorableImage(previous) : undefined;
    if (lost) advice.push(`The current ${kind} (${previous}) cannot be restored afterwards: ${lost}. Flarum deletes it on upload, so a rollback will not bring it back.`);
    if (kind === "logo_dark_mode" && this.local) {
      // views/frontend/forum.blade.php renders the dark logo only inside @if ($forum['logoUrl']).
      const normal = valueOf(await this.db.read(["logo_path"]), "logo_path");
      if (!normal) advice.push("No normal logo is set: Flarum only shows the dark-mode logo when a normal logo exists (forum.blade.php). Upload a normal logo too, or the dark logo stays invisible.");
    }
    if (!opts.confirm) {
      return { dryRun: true, wouldUpload: { kind, route: `/api${spec.route}`, field: spec.field, file, ...info, bytes: data.byteLength }, advice };
    }
    await requireAdmin(this.client);
    // Flarum deletes the previous file on upload; the snapshot keeps a copy of it.
    return this.guardedWrite(`before-upload-${kind}`, [spec.pathKey], async (snap) => {
      const before = this.local ? valueOf(await this.db.read([spec.pathKey]), spec.pathKey) : undefined;
      const res = await this.client.upload<{ data?: { attributes?: Record<string, unknown> } }>({
        path: spec.route,
        field: spec.field,
        filename: `${kind}.${info.ext}`,
        data,
        mimeType: info.mime,
        timeoutMs: 120_000,
      });
      if (!res.ok) throw new OpsError(`upload failed (${res.status}): ${describeFailure(res)}`, [{ step: "upload", method: "POST", path: `/api${spec.route}`, status: res.status, ok: false }]);
      const url = (res.body as { data?: { attributes?: Record<string, unknown> } })?.data?.attributes?.[spec.urlAttr];
      let verify: Record<string, unknown> = { ok: true };
      if (this.local) {
        const after = valueOf(await this.db.read([spec.pathKey]), spec.pathKey);
        // Flarum stores a fresh random file name on every upload, so the path must be set and different.
        verify = { ok: Boolean(after) && after !== before, [spec.pathKey]: after ?? "(none)" };
      }
      const steps: StepResult[] = [{ step: "upload", method: "POST", path: `/api${spec.route}`, status: res.status, ok: true }];
      requireVerified(verify, steps, `${kind} upload`);
      // Do not promise a rollback that cannot bring the previous image back.
      return { dryRun: false, ...snap, ...(lost ? { rollback: null, rollbackNote: `the previous ${kind} is not restorable: ${lost}` } : {}), steps, url, advice, verify };
    });
  }

  async deleteImage(kind: ImageKind, opts: { confirm?: boolean } = {}): Promise<Record<string, unknown>> {
    const spec = IMAGE_KINDS[kind];
    if (!spec) throw new Error(`unknown image kind "${kind}"`);
    const current = this.local ? valueOf(await this.db.read([spec.pathKey]), spec.pathKey) : undefined;
    const lost = current ? this.unrestorableImage(current) : undefined;
    const warning = lost ? `the deleted ${kind} cannot be restored afterwards: ${lost}` : undefined;
    if (!opts.confirm) return { dryRun: true, wouldDelete: { kind, route: `/api${spec.route}`, current: current ?? "(none)" }, ...(warning ? { warning } : {}) };
    if (this.local && !current) return { dryRun: false, steps: [], note: `no ${kind} is set; nothing to delete` };
    await requireAdmin(this.client);
    return this.guardedWrite(`before-delete-${kind}`, [spec.pathKey], async (snap) => {
      const res = await this.client.raw({ method: "DELETE", path: spec.route });
      if (!res.ok) throw new OpsError(`delete failed (${res.status}): ${describeFailure(res)}`);
      const verify = this.local
        ? { ok: !valueOf(await this.db.read([spec.pathKey]), spec.pathKey) }
        : { ok: true };
      const steps: StepResult[] = [{ step: `delete ${kind}`, method: "DELETE", path: `/api${spec.route}`, status: res.status, ok: true }];
      requireVerified(verify, steps, `${kind} delete`);
      return { dryRun: false, ...snap, ...(warning ? { rollback: null, rollbackNote: warning } : {}), steps, verify };
    });
  }

  /**
   * PATCH /api/extensions/{id} {"enabled": bool}. Enabling runs the
   * extension's migrations (schema changes) and publishes its assets, so this
   * always needs an explicit approval. Uninstalling is not offered.
   */
  async extensionSet(id: string, enabled: boolean, opts: { confirm?: boolean } = {}): Promise<Record<string, unknown>> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`"${id}" is not an extension id (e.g. flarum-gdpr)`);
    const current = this.local ? (await this.enabledExtensions()).includes(id) : undefined;
    if (current === enabled) return { dryRun: !opts.confirm, note: `${id} is already ${enabled ? "enabled" : "disabled"}`, steps: [] };
    if (!opts.confirm) {
      return {
        dryRun: true,
        wouldSend: { method: "PATCH", path: `/api/extensions/${id}`, body: { enabled } },
        currentlyEnabled: current,
        warning: enabled
          ? "Enabling runs the extension's database migrations and publishes its assets. Take a DB backup first; disabling later does NOT roll migrations back."
          : "Disabling hides the extension's features; its data and migrations stay.",
      };
    }
    await requireAdmin(this.client);
    // Under the design-set lock so a toggle never lands inside a running apply/preview (whose rollback would then
    // compare against a different set of extension settings). No snapshot: it could not undo migrations anyway.
    if (this.local && this.lockGuard) return this.lockGuard(() => this.extensionToggle(id, enabled));
    return this.extensionToggle(id, enabled);
  }

  private async extensionToggle(id: string, enabled: boolean): Promise<Record<string, unknown>> {
    const started = new Date();
    const res = await this.client.raw({ method: "PATCH", path: `/extensions/${id}`, body: { enabled }, timeoutMs: 300_000 });
    const steps: StepResult[] = [{ step: `${enabled ? "enable" : "disable"} ${id}`, method: "PATCH", path: `/api/extensions/${id}`, status: res.status, ok: res.ok, detail: res.ok ? undefined : describeFailure(res) }];
    const health = await this.health(started);
    if (!res.ok) throw new OpsError(`extension toggle failed (${res.status}): ${describeFailure(res)}`, steps);
    // Read-back: extensions_enabled must now (not) list the id.
    const verify = this.local ? { ok: (await this.enabledExtensions()).includes(id) === enabled } : { ok: true };
    requireVerified(verify, steps, `${enabled ? "enable" : "disable"} ${id}`);
    return { dryRun: false, steps, health, verify };
  }

  /** POST /api/permission replaces ALL groups for the permission; shows the current groups first. */
  async permissionSet(permission: string, groupIds: number[], opts: { confirm?: boolean } = {}): Promise<Record<string, unknown>> {
    const current = this.local ? (await this.db.permissions([permission]))[permission] ?? [] : undefined;
    if (!opts.confirm) {
      return {
        dryRun: true,
        permission,
        currentGroupIds: current,
        newGroupIds: groupIds,
        note: "Replaces every group currently holding this permission. Groups: 1 admin, 2 guest, 3 member, 4 mod (default ids).",
      };
    }
    await requireAdmin(this.client);
    // Permissions are not part of design-set snapshots: previousGroupIds (read before the write) is the record to
    // restore from, e.g. permissionSet(permission, previousGroupIds).
    const res = await this.client.raw({ method: "POST", path: "/permission", body: { permission, groupIds } });
    if (!res.ok) throw new OpsError(`permission update failed (${res.status}): ${describeFailure(res)}`);
    let verify: Record<string, unknown> = { ok: true };
    if (this.local) {
      const now = [...((await this.db.permissions([permission]))[permission] ?? [])].sort((a, b) => a - b);
      const want = [...new Set(groupIds)].sort((a, b) => a - b);
      verify = { ok: JSON.stringify(now) === JSON.stringify(want), groupIds: now };
    }
    const steps: StepResult[] = [{ step: "permission", method: "POST", path: "/api/permission", status: res.status, ok: true }];
    const restore = current ? `permission ${permission} ${current.length ? current.join(",") : "none"}` : undefined;
    requireVerified(verify, steps, `permission ${permission}`, restore ? `Previous groups restore with: ${restore}` : undefined);
    return { dryRun: false, steps, previousGroupIds: current, restore, verify };
  }
}

export function summarise(s: SettingsMap[string] | undefined): string {
  if (!s || s.state === "absent") return "(absent)";
  if (s.state === "null") return "(null)";
  if (s.state === "redacted") return "***";
  return preview(s.value);
}

export function preview(v: string | null | undefined): string {
  if (v === null || v === undefined) return "(null)";
  return v.length > 120 ? `${v.slice(0, 117)}… [${v.length} chars]` : v;
}

export { FlarumError };
