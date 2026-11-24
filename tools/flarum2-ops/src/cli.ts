#!/usr/bin/env node
/**
 * flarum2-ops CLI: same engine as the MCP server, for terminals, cron and
 * agents without MCP. Output is JSON on stdout; diagnostics go to stderr.
 *
 * Every mutating command is a dry run unless --confirm is given.
 * Exit codes: 0 ok · 1 error · 2 usage · 3 dry run (nothing changed; re-run with --confirm).
 */

import { envPositiveNumber, loadConfig, loadToken, redact } from "./config.js";
import { FlarumClient, normalizeApiPath } from "./flarum-client.js";
import { Ops, OpsError } from "./ops.js";
import { DesignSets, installInterruptHandling, signalExitCode } from "./designset.js";
import { insecureLoginWarning, loginAndStore, promptHidden, promptVisible } from "./auth.js";
import { IMAGE_KINDS, managedWrite, type ImageKind } from "./policy.js";
import { VERSION, DEFAULT_USER_AGENT } from "./version.js";

const HELP = `flarum2-ops ${VERSION} — Flarum 2 admin + design-set CLI

Usage: flarum2-ops <command> [args] [--confirm] [--compact]

Setup
  login [--allow-insecure-http] ask for admin login (hidden), store a remember token (0600); https only by default
  whoami                        forum + acting user (admin check)
  doctor                        one-shot status: config, token, health, drift, sets
  health                        services, root/API/CSS HTTP, logs, custom_less_error

Settings & admin API
  settings get <key>... [--prefix p.]   read from DB (secrets redacted)
  settings keys                          list all setting key names
  settings set k=v [k=v...] [--allow-protected] [--confirm]
  settings set-file <key> <file> [--confirm]       e.g. custom_less from a .less file
  settings reset <key>... [--allow-protected] [--confirm]  back to Flarum defaults
  image upload <logo|logo_dark_mode|email_logo|favicon> <file> [--confirm]
  image delete <kind> [--confirm]
  cache clear [--confirm]
  extension <id> on|off [--confirm]                 enabling runs migrations!
  permission <name> <groupId,...|none> [--confirm]  replaces all groups
  api <GET|POST|PATCH|DELETE> <path> [json-body] [--confirm for non-GET]

Design-sets
  designset list | snapshots
  designset new <name> [title]
  designset export <name> [title]       live design → new set
  designset validate <name>
  designset diff <name>                 what apply would change
  designset apply <name> [--confirm] [--no-auto-rollback]
  designset preview <name> [--confirm] [--viewports 1440,390]
  designset rollback [snapshot-id] [--other-forum] [--allow-protected] [--confirm]   default: last pre-write snapshot of this forum
  designset prune-snapshots [--keep 20] [--confirm]  delete all but the newest N snapshots
  designset screenshot [name] [--viewports 1440,390] [--pages /,/all]
  designset gallery
`;

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const k = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const v = eq < 0 ? undefined : a.slice(eq + 1); // values may contain "=" (--pages=/d/1?a=b)
      if (v !== undefined) flags[k] = v;
      else if (["prefix", "viewports", "pages", "keep"].includes(k) && argv[i + 1] && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function emit(data: unknown, compact: boolean): void {
  process.stdout.write(JSON.stringify(data, null, compact ? 0 : 2) + "\n");
}

function isDryRun(data: unknown): boolean {
  return Boolean(data && typeof data === "object" && (data as { dryRun?: boolean }).dryRun);
}

/** Wrong command or arguments: printed with the help on stderr, exit 2 (as documented), not a JSON error. */
class UsageError extends Error {}

async function main(): Promise<number> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, sub, ...rest] = positional;
  const compact = Boolean(flags.compact);
  const confirm = Boolean(flags.confirm);
  if (!cmd || cmd === "help" || flags.help) {
    process.stdout.write(HELP);
    return cmd ? 0 : 2;
  }
  if (cmd === "version" || flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const cfg = loadConfig();
  if (!cfg.baseUrl) {
    process.stderr.write("No forum URL: set base_url in forum.json or FLARUM_URL.\n");
    return 2;
  }

  if (cmd === "login") {
    const insecure = insecureLoginWarning(cfg.baseUrl);
    if (insecure && !flags["allow-insecure-http"]) {
      // The password would cross the network in clear text: never by default.
      process.stderr.write(`${insecure}\nRefusing to log in. Use https in base_url, or pass --allow-insecure-http if you accept that.\n`);
      return 2;
    }
    if (!process.stdin.isTTY) {
      process.stderr.write(
        "login needs an interactive terminal (the password is typed hidden and never passes through an agent).\n" +
          "Claude Code '!' commands and pipes have no keyboard input. Open a normal terminal window and run:\n" +
          `  bash ${process.argv[1].replace(/tools\/flarum2-ops\/dist\/cli\.js$/, "skills/flarum2-design-ops/scripts/ops.sh")} login\n`,
      );
      return 2;
    }
    if (insecure) process.stderr.write(`Warning: ${insecure}\n`);
    const ident = await promptVisible(`Admin username or email for ${cfg.baseUrl}: `);
    const password = await promptHidden("Password (hidden): ");
    const { userId } = await loginAndStore(cfg.baseUrl, ident, password, cfg.tokenFile, DEFAULT_USER_AGENT);
    const ops = new Ops(cfg, new FlarumClient({ baseUrl: cfg.baseUrl, apiKey: loadToken(cfg).token, userAgent: DEFAULT_USER_AGENT }));
    const { actor } = await ops.whoami();
    emit({ stored: cfg.tokenFile, mode: "0600", userId, admin: actor.isAdmin }, compact);
    if (!actor.isAdmin) process.stderr.write("Warning: this user is not an admin; design-set and settings writes will fail.\n");
    return 0;
  }

  const token = loadToken(cfg);
  if (token.warning) process.stderr.write(`Warning: ${token.warning}\n`);
  // Same environment as the MCP server: FLARUM_USER_ID (act as a user with a master API key), FLARUM_USER_AGENT, FLARUM_TIMEOUT.
  const client = new FlarumClient({
    baseUrl: cfg.baseUrl,
    apiKey: token.token,
    userId: process.env.FLARUM_USER_ID,
    userAgent: process.env.FLARUM_USER_AGENT || DEFAULT_USER_AGENT,
    timeoutMs: envPositiveNumber(process.env.FLARUM_TIMEOUT),
    readOnly: false,
  });
  const ops = new Ops(cfg, client);
  const sets = new DesignSets(ops);
  const csv = (v: string | boolean | undefined) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
  const viewports = csv(flags.viewports)?.map(Number);
  const pages = csv(flags.pages);

  let out: unknown;
  let invalid = false; // designset validate found errors: exit 1, as documented ("error/blocked by validation")
  switch (cmd) {
    case "whoami":
      out = await ops.whoami();
      break;
    case "doctor":
      out = await sets.doctor();
      break;
    case "health":
      out = await ops.health();
      break;
    case "settings": {
      if (sub === "get") {
        const prefixes = csv(flags.prefix) ?? [];
        if (!rest.length && !prefixes.length) throw new UsageError("settings get <key>... [--prefix p.]");
        out = await ops.settingsGet(rest, prefixes);
      } else if (sub === "keys") {
        out = await ops.db.listKeys();
      } else if (sub === "set") {
        const values: Record<string, string> = {};
        for (const kv of rest) {
          const i = kv.indexOf("=");
          if (i < 1) throw new Error(`expected key=value, got "${kv}"`);
          values[kv.slice(0, i)] = kv.slice(i + 1);
        }
        out = await ops.settingsSet(values, { confirm, allowProtected: Boolean(flags["allow-protected"]) });
      } else if (sub === "set-file") {
        const [key, file] = rest;
        if (!key || !file) throw new UsageError("settings set-file <key> <file>");
        const { readFileSync } = await import("node:fs");
        out = await ops.settingsSet({ [key]: readFileSync(file, "utf8") }, { confirm, allowProtected: Boolean(flags["allow-protected"]) });
      } else if (sub === "reset") {
        out = await ops.settingsReset(rest, { confirm, allowProtected: Boolean(flags["allow-protected"]) });
      } else throw new UsageError("settings get|keys|set|set-file|reset");
      break;
    }
    case "image": {
      const kind = rest[0] as ImageKind;
      if (!(kind in IMAGE_KINDS)) throw new UsageError(`image ${sub} <${Object.keys(IMAGE_KINDS).join("|")}>`);
      if (sub === "upload" && !rest[1]) throw new UsageError(`image upload ${kind} <file>`);
      if (sub === "upload") out = await ops.uploadImage(kind, rest[1], { confirm });
      else if (sub === "delete") out = await ops.deleteImage(kind, { confirm });
      else throw new UsageError("image upload|delete");
      break;
    }
    case "cache":
      if (sub !== "clear") throw new UsageError("cache clear");
      out = await ops.cacheClear({ confirm });
      break;
    case "extension": {
      const state = rest[0];
      if (!sub || !["on", "off"].includes(state)) throw new UsageError("extension <id> on|off");
      out = await ops.extensionSet(sub, state === "on", { confirm });
      break;
    }
    case "permission": {
      if (!sub || !rest[0]) throw new UsageError("permission <name> <groupId,...|none>");
      // "none" = no group holds the permission (also what `restore` prints for an empty list).
      const ids = rest[0] === "none" ? [] : rest[0].split(",").map(Number);
      if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new Error(`permission: "${rest[0]}" is not a list of group ids (or "none")`);
      out = await ops.permissionSet(sub, ids, { confirm });
      break;
    }
    case "api": {
      const method = (sub ?? "GET").toUpperCase();
      const path = rest[0];
      if (!path) throw new UsageError("api <METHOD> <path> [json-body]");
      const body = rest[1] ? JSON.parse(rest[1]) : undefined;
      const managed = method !== "GET" ? managedWrite(normalizeApiPath(path)) : undefined;
      if (managed) throw new Error(`${method} ${path} is refused here: use \`${managed.cli}\` (key policy, snapshot, read-back).`);
      if (method !== "GET" && !confirm) {
        out = { dryRun: true, wouldSend: { method, path, body } };
      } else {
        const res = await client.raw({ method, path, body });
        out = res;
        invalid = !res.ok; // HTTP error: exit 1, as documented (and as the MCP tool sets isError)
      }
      break;
    }
    case "designset": {
      const name = rest[0];
      if (["new", "export", "validate", "diff", "apply", "preview"].includes(sub) && !name) throw new UsageError(`designset ${sub} <name>`);
      switch (sub) {
        case "list":
          out = sets.list();
          break;
        case "snapshots":
          out = sets.listSnapshots();
          break;
        case "new":
          out = sets.create(name, rest[1]);
          break;
        case "export":
          out = await sets.exportLive(name, rest[1]);
          break;
        case "validate":
          out = await sets.validate(name);
          invalid = (out as { ok?: boolean }).ok === false;
          break;
        case "diff":
          out = await sets.plan(name);
          break;
        case "apply":
          out = await sets.apply(name, { confirm, autoRollback: !flags["no-auto-rollback"] });
          break;
        case "preview":
          out = await sets.preview(name, { confirm, viewports, pages });
          break;
        case "rollback":
          out = await sets.rollback(name, { confirm, allowOtherForum: Boolean(flags["other-forum"]), allowProtected: Boolean(flags["allow-protected"]) });
          break;
        case "prune-snapshots":
          out = await sets.pruneSnapshots({ keep: typeof flags.keep === "string" ? Number(flags.keep) : undefined, confirm });
          break;
        case "screenshot": {
          const { join } = await import("node:path");
          const outDir = name ? join(sets.setDir(name), "screenshots") : join(cfg.designSetsDir, "_live-screenshots");
          out = await sets.screenshot({ outDir, viewports, pages });
          break;
        }
        case "gallery":
          out = sets.gallery();
          break;
        default:
          throw new UsageError("designset list|snapshots|new|export|validate|diff|apply|preview|rollback|prune-snapshots|screenshot|gallery");
      }
      break;
    }
    default:
      process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}`);
      return 2;
  }
  emit(out, compact);
  if (isDryRun(out)) {
    // `blocked` is a boolean (settings/designset) or the list of refused keys (settings reset): [] means not blocked.
    const isBlocked = (b: unknown) => (Array.isArray(b) ? b.length > 0 : Boolean(b));
    const o = out as { plan?: { blocked?: unknown }; blocked?: unknown };
    const blocked = isBlocked(o.plan?.blocked) || isBlocked(o.blocked);
    process.stderr.write(blocked ? "Blocked by validation errors (see issues); nothing was changed.\n" : "Dry run: nothing was changed. Re-run with --confirm after approval.\n");
    return blocked ? 1 : 3;
  }
  if (invalid) {
    process.stderr.write("Validation errors (see issues).\n");
    return 1;
  }
  return 0;
}

installInterruptHandling((m) => process.stderr.write(`[flarum2-ops] ${m}\n`));

/** Exit only after stdout is flushed: with a pipe, process.exit() right after a large write truncates the JSON. */
function exitAfterFlush(code: number): void {
  const final = signalExitCode() ?? code; // interrupted by a signal: report that, not the failed write
  process.stdout.write("", () => process.exit(final));
}

main()
  .then((code) => exitAfterFlush(code))
  .catch((err: unknown) => {
    if (err instanceof UsageError) {
      process.stderr.write(`Usage: flarum2-ops ${err.message}\n\n${HELP}`);
      exitAfterFlush(2);
      return;
    }
    const token = (() => {
      try {
        return loadToken(loadConfig()).token;
      } catch {
        return undefined;
      }
    })();
    const e = err as Error & { steps?: unknown };
    const payload: Record<string, unknown> = { error: redact(e.message, token) };
    if (err instanceof OpsError && e.steps) payload.steps = e.steps;
    process.stdout.write(redact(JSON.stringify(payload, null, 2), token) + "\n");
    exitAfterFlush(1);
  });
