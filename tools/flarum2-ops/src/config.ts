/**
 * Target configuration for flarum2-ops.
 *
 * Resolution order (first wins per field):
 *   1. environment: FLARUM_URL, FLARUM_ROOT, FLARUM_TOKEN_FILE, FLARUM_API_KEY,
 *      FLARUM_DESIGN_SETS_DIR, FLARUM_SERVICES
 *   2. the JSON file named by FLARUM2_OPS_CONFIG
 *   3. forum.json in the repository root (two levels above the package)
 *
 * forum.json holds no secrets. The credential lives in a 0600 token file
 * (default ~/.config/flarum2/token) written by `flarum2-ops login`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface OpsConfig {
  /** Display name of the target forum. */
  name: string;
  /** Forum base URL without /api, e.g. http://127.0.0.1:8080 */
  baseUrl?: string;
  /** Local install path (enables the PDO settings reader, logs, static assets). */
  forumRoot?: string;
  /** Absolute path of the token file. */
  tokenFile: string;
  /** Absolute path of the design-sets directory. */
  designSetsDir: string;
  /** Sub-directory of <forumRoot>/public/assets that receives design-set static files. */
  publicAssetsSubdir: string;
  /** systemd units checked by the health check. */
  services: string[];
  /** Repository root (where forum.json lives). */
  repoRoot: string;
  /** Where the config came from, for diagnostics. */
  source: string;
}

/** Directory of the package (…/tools/flarum2-ops), from dist/ or src/. */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Cannot read config ${file}: ${(err as Error).message}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OpsConfig {
  const defaultRepo = resolve(packageRoot(), "..", "..");
  const explicit = env.FLARUM2_OPS_CONFIG;
  const candidate = explicit ? resolve(expandHome(explicit)) : join(defaultRepo, "forum.json");
  if (explicit && !existsSync(candidate)) {
    throw new Error(`FLARUM2_OPS_CONFIG points to a missing file: ${candidate}`);
  }
  const hasFile = existsSync(candidate);
  const fileCfg = hasFile ? readJson(candidate) : {};
  const repoRoot = hasFile ? dirname(candidate) : defaultRepo;
  const rel = (p: string) => (isAbsolute(p) ? p : resolve(repoRoot, p));
  const str = (k: string) => (typeof fileCfg[k] === "string" ? (fileCfg[k] as string) : undefined);

  const services = env.FLARUM_SERVICES
    ? env.FLARUM_SERVICES.split(",").map((s) => s.trim()).filter(Boolean)
    : Array.isArray(fileCfg.services)
      ? (fileCfg.services as unknown[]).filter((s): s is string => typeof s === "string")
      : ["nginx", "php8.4-fpm", "mariadb"];

  const forumRoot = env.FLARUM_ROOT ?? str("forum_root");
  // One folder name under public/assets: static files are published (and old versions removed) below it, so ""
  // or ".." would point the engine at Flarum's own assets.
  const publicAssetsSubdir = str("public_assets_subdir") ?? "design-sets";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(publicAssetsSubdir)) {
    throw new Error(`public_assets_subdir must be a single folder name (letters, digits, _ -), got ${JSON.stringify(publicAssetsSubdir)}`);
  }
  return {
    name: str("name") ?? "flarum",
    baseUrl: (env.FLARUM_URL ?? str("base_url"))?.replace(/\/+$/, ""),
    forumRoot: forumRoot ? resolve(expandHome(forumRoot)) : undefined,
    tokenFile: resolve(expandHome(env.FLARUM_TOKEN_FILE ?? str("token_file") ?? "~/.config/flarum2/token")),
    designSetsDir: rel(expandHome(env.FLARUM_DESIGN_SETS_DIR ?? str("design_sets_dir") ?? "design-sets")),
    publicAssetsSubdir,
    services,
    repoRoot,
    source: hasFile ? candidate : "environment",
  };
}

/** A positive number from an environment variable, or undefined (so "abc" never becomes NaN, i.e. a 1 ms timeout). */
export function envPositiveNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export interface TokenInfo {
  token?: string;
  source: "env" | "file" | "none";
  /** Human-readable warning (e.g. permissive file mode). Never contains the token. */
  warning?: string;
}

/**
 * Load the API credential. FLARUM_API_KEY (env) wins for compatibility with
 * mcp-for-flarum; otherwise the token file. The value is never logged.
 */
/**
 * A token is sent as `Authorization: Token <token>`: anything outside visible ASCII (a line break from a
 * multi-line token file, a space) makes fetch throw an error whose message contains the header value, i.e. the
 * secret. Refuse such a credential up front, with a message that never includes it.
 */
export function assertHeaderSafeToken(token: string, where: string): void {
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new Error(`The credential from ${where} contains characters not allowed in an HTTP header (a line break or space inside it?). Fix ${where}; the value is not shown.`);
  }
}

export function loadToken(cfg: OpsConfig, env: NodeJS.ProcessEnv = process.env): TokenInfo {
  if (env.FLARUM_API_KEY) {
    const token = env.FLARUM_API_KEY.trim();
    assertHeaderSafeToken(token, "FLARUM_API_KEY");
    return { token, source: "env" };
  }
  if (!existsSync(cfg.tokenFile)) return { source: "none" };
  const st = statSync(cfg.tokenFile);
  let warning: string | undefined;
  if ((st.mode & 0o077) !== 0) {
    warning = `Token file ${cfg.tokenFile} is readable by group/others (mode ${(st.mode & 0o777).toString(8)}); run: chmod 600 ${cfg.tokenFile}`;
  }
  const token = readFileSync(cfg.tokenFile, "utf8").trim();
  if (token) assertHeaderSafeToken(token, `the token file ${cfg.tokenFile}`);
  return token ? { token, source: "file", warning } : { source: "none", warning: `Token file ${cfg.tokenFile} is empty` };
}

/** Replace any occurrence of the secret in a string (defence in depth for error output). */
export function redact(text: string, secret?: string): string {
  if (!secret || secret.length < 6) return text;
  return text.split(secret).join("***");
}
