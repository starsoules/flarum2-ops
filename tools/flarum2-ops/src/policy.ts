/**
 * Settings key policy and value validation for Flarum 2.0.x.
 *
 * Facts (verified against flarum/core 2.0.2):
 *  - POST /api/settings stores every value as a string; booleans become '1'/'0'.
 *  - Values longer than 65000 chars are rejected (SettingsValidator).
 *  - color_scheme is NOT validated server-side; valid ids come from
 *    js/src/common/components/ThemeMode.tsx.
 *  - allow_user_color_scheme is written by the admin UI but read nowhere.
 *  - custom_less: data-uri() refused, local @import only from Flarum's own
 *    import dirs, compiled BEFORE extension LESS (ForumServiceProvider:140).
 */

export const COLOR_SCHEMES = ["auto", "light", "dark", "light-hc", "dark-hc"] as const;
export const MAX_SETTING_LENGTH = 65000;

/**
 * "Theme" keys: a design-set fully defines these. When a set omits one, apply
 * resets it to Flarum's default so switching sets is deterministic.
 */
export const THEME_KEYS = [
  "theme_primary_color",
  "theme_secondary_color",
  "theme_colored_header",
  "color_scheme",
  "show_theme_selector",
  "custom_less",
  "custom_header",
  "custom_footer",
] as const;

/** Optional presentation/content keys: only touched when a set specifies them. */
export const OPTIONAL_DESIGN_KEYS = [
  "forum_title",
  "forum_description",
  "welcome_title",
  "welcome_message",
  "default_route",
  "show_language_selector",
  "fontawesome_source",
  "fontawesome_cdn_url",
  "fontawesome_kit_url",
  "fontawesome_forced_style",
] as const;

/** Image setting keys (managed through the upload endpoints, never POSTed directly). */
export const IMAGE_KINDS = {
  logo: { route: "/logo", field: "logo", pathKey: "logo_path", urlAttr: "logoUrl" },
  logo_dark_mode: { route: "/logo-dark-mode", field: "logo-dark-mode", pathKey: "logo_dark_mode_path", urlAttr: "logoDarkModeUrl" },
  email_logo: { route: "/email-logo", field: "email-logo", pathKey: "email_logo_path", urlAttr: "emailLogoUrl" },
  favicon: { route: "/favicon", field: "favicon", pathKey: "favicon_path", urlAttr: "faviconUrl" },
} as const;
export type ImageKind = keyof typeof IMAGE_KINDS;

/** Keys whose change needs DELETE /api/cache to show up (no automatic rebuild). */
export const NEEDS_CACHE_CLEAR_KEYS = ["fontawesome_source", "fontawesome_cdn_url", "fontawesome_kit_url"];

/**
 * Whether writing these values needs an explicit cache clear: Flarum rebuilds CSS on save only for keys that are set
 * to a value (ValidateCustomLess: isset()), so NULL on a CSS key, and any Font Awesome source change, leave the
 * old CSS/icons live until the cache is cleared.
 */
export function writeNeedsCacheClear(values: Record<string, string | null>): boolean {
  return Object.entries(values).some(([k, v]) => NEEDS_CACHE_CLEAR_KEYS.includes(k) || (v === null && CSS_KEYS.includes(k)));
}

/** Keys that the forum CSS depends on (rebuild triggers / reset side effects). */
export const CSS_KEYS = ["custom_less", "theme_primary_color", "theme_secondary_color"];

/** Never writable through this tool: managed by Flarum itself, writing them breaks things. */
const FORBIDDEN: RegExp[] = [
  /^extensions_enabled$/,
  /^version$/,
  /^assets_dirty\./,
  /^custom_less_error$/,
  /^(logo|logo_dark_mode|email_logo|favicon)_path$/,
  /^(email_logo|logo_email_copy)_(path|size)$/,
];

/** Writable only with an explicit protected-key confirmation. */
const PROTECTED: RegExp[] = [
  /^maintenance_mode$/,
  /^safe_mode_extensions$/,
  /^mail_/,
  /(pass(word)?|pwd|secret|token|api_?key|access_?key|s3_?key|private|credential|dsn|webhook|jwt|salt|bearer|(^|[._-])key$)/i,
  /^(slug|search|display_name|avatar)_driver/,
  /^default_locale$/,
  /^allow_sign_up$/,
];

/** Same rule as the PHP reader: values of these keys are never displayed. */
export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  if (/^mail_/.test(k) && !["mail_driver", "mail_format", "mail_from"].includes(k)) return true;
  // dsn / webhook: connection strings and hook URLs carry credentials (e.g. "*.dsn", "*.webhook_url").
  // …Key / …KeyId in camelCase extension keys ("fof-upload.awsS3Key") are checked on the original spelling.
  return /(pass(word)?|pwd|secret|token|api_?key|access_?key|s3_?key|private|credential|dsn|webhook|jwt|salt|bearer|(^|[._-])key$)/.test(k) || /[a-z0-9]Key(Id)?$/.test(key);
}

/**
 * Flarum's settings table uses utf8mb4_unicode_ci (core Install/DatabaseConfig.php): key lookups and the upsert
 * ignore case, trailing spaces and accents, so "Extensions_Enabled", "extensions_enabled " and "extensíons_enabled"
 * all hit the row extensions_enabled. Policy checks therefore run on the lower-cased key, and keys outside
 * Flarum's own alphabet are refused outright.
 */
const KEY_ALPHABET = /^[A-Za-z0-9._-]+$/;

export type KeyClass = "theme" | "optional" | "extension" | "protected" | "forbidden" | "other";

export function classifyKey(key: string, enabledExtensionIds: string[] = []): KeyClass {
  if (!KEY_ALPHABET.test(key)) return "forbidden";
  const k = key.toLowerCase();
  if (FORBIDDEN.some((r) => r.test(k))) return "forbidden";
  if (PROTECTED.some((r) => r.test(k))) return "protected";
  // A design key in another spelling ("Custom_Less") would hit the same row (case-insensitive collation) while value
  // checks, the LESS lint and Flarum's own ValidateCustomLess (isset($settings['custom_less'])) all compare exactly.
  // Only the exact spelling is allowed.
  if ((THEME_KEYS as readonly string[]).includes(k)) return key === k ? "theme" : "forbidden";
  if ((OPTIONAL_DESIGN_KEYS as readonly string[]).includes(k)) return key === k ? "optional" : "forbidden";
  if (extensionPrefixOf(key, enabledExtensionIds)) return "extension";
  return "other";
}

/**
 * Extension settings are conventionally prefixed with the extension id
 * ("flarum-tags.max_primary_tags", "fof-upload.mimeTypes") or the vendor-name
 * form with a dash. Returns the matching extension id, if any.
 */
export function extensionPrefixOf(key: string, extensionIds: string[]): string | undefined {
  const head = key.split(".")[0];
  return extensionIds.find((id) => head === id || head === id.replace(/^flarum-/, ""));
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const BOOL_KEYS = new Set(["theme_colored_header", "show_theme_selector", "show_language_selector"]);

export interface ValidationIssue {
  key: string;
  level: "error" | "warning";
  message: string;
}

/** Normalise a value to what Flarum stores (strings; booleans as '1'/'0'). */
export function normaliseValue(key: string, value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (BOOL_KEYS.has(key) && /^(true|false)$/i.test(value)) return /^true$/i.test(value) ? "1" : "0";
    return value;
  }
  return JSON.stringify(value);
}

/** Constructs in raw HTML (or SVG) that run code or pull in other pages; empty when none. Heuristic, never exhaustive. */
export function activeHtml(raw: string): string[] {
  // Browsers drop tab/CR/LF inside URL schemes ("java\tscript:"), so test without them as well.
  const value = `${raw}\n${raw.replace(/[\t\r\n]/g, "")}`;
  return [
    /<([\w-]+:)?script\b/i.test(value) ? "<script>" : "", // also <svg:script> / <x:script xmlns:x=…>
    // on…= after whitespace, "/" or a quote: <svg/onload=…>, <img src=x/onerror=…>, <a href=""onclick=…>
    /<[^>]*[\s/"']on[a-z]+\s*=/i.test(value) ? "an inline event handler (on…=)" : "",
    /(javascript|vbscript)\s*:/i.test(value) ? "a javascript: URL" : "",
    /(href|src|action|data)\s*=\s*["']?[^"'>]*&#/i.test(value) ? "an entity-encoded URL (can hide javascript:)" : "",
    /<(iframe|object|embed|base|form|frame|frameset)\b/i.test(value) ? "an embedded frame, object, form or <base>" : "",
    /<meta\b[^>]*http-equiv/i.test(value) ? "a <meta http-equiv> (refresh / redirect)" : "",
    /<link\b[^>]*\bhref\s*=\s*["']?(https?:)?\/\//i.test(value) ? "a <link> to another host" : "",
  ].filter(Boolean);
}

export function validateValue(key: string, value: string | null): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (value === null) {
    issues.push({
      key,
      level: "warning",
      message: "null stores a NULL row that hides Flarum's default; use a reset (DELETE) to return to the default",
    });
    return issues;
  }
  if (value.length > MAX_SETTING_LENGTH) {
    issues.push({ key, level: "error", message: `value is ${value.length} chars; Flarum rejects values over ${MAX_SETTING_LENGTH}` });
  }
  if ((key === "theme_primary_color" || key === "theme_secondary_color") && !HEX.test(value)) {
    issues.push({ key, level: "error", message: `must be a hex color like #4D698E (got "${value.slice(0, 40)}")` });
  }
  if ((key === "theme_primary_color" || key === "theme_secondary_color") && /@impor|data-uri\s*\(/i.test(value)) {
    issues.push({ key, level: "error", message: "LESS directives are refused in color settings" });
  }
  if (key === "color_scheme" && !(COLOR_SCHEMES as readonly string[]).includes(value)) {
    issues.push({ key, level: "error", message: `must be one of ${COLOR_SCHEMES.join(", ")} (the server does not validate this)` });
  }
  if (BOOL_KEYS.has(key) && value !== "0" && value !== "1") {
    issues.push({ key, level: "error", message: 'must be "1"/"0" (or true/false)' });
  }
  if (key === "default_route" && !value.startsWith("/")) {
    issues.push({ key, level: "error", message: 'must be a forum route such as "/all" or "/tags"' });
  }
  if (key === "custom_less") issues.push(...lintLess(value));
  if (key === "custom_header" || key === "custom_footer" || key === "welcome_message") {
    // The value is output as raw HTML for every visitor (also admins): anything that runs code or loads a page.
    const active = activeHtml(value);
    if (active.length) {
      issues.push({
        key,
        level: "warning",
        message: `contains ${active.join(", ")}: it runs for every visitor (raw, unescaped HTML) and is readable by guests via /api`,
      });
    }
    // Images, media, styles from another host: every visitor's browser contacts it (tracking pixel, CDN).
    const hosts = new Set<string>();
    for (const m of value.matchAll(/\b(?:src|srcset|poster|background)\s*=\s*["']?((?:https?:)?\/\/[^"'\s>/]+)/gi)) hosts.add(m[1].replace(/^(https?:)?\/\//, ""));
    for (const m of value.matchAll(/url\(\s*["']?((?:https?:)?\/\/[^"')\s/]+)/gi)) hosts.add(m[1].replace(/^(https?:)?\/\//, ""));
    if (hosts.size) {
      issues.push({ key, level: "warning", message: `loads resources from ${[...hosts].join(", ")} for every visitor (privacy/GDPR); prefer files in the set's static/ folder` });
    }
  }
  if (key === "fontawesome_kit_url" && value.trim()) {
    // core FrontendServiceProvider: <script src="{kit url}" defer> on every page, admin included.
    if (!/^https:\/\/kit\.fontawesome\.com\/[\w.-]+\.js$/.test(value.trim())) {
      issues.push({ key, level: "error", message: "must be a https://kit.fontawesome.com/<id>.js URL: Flarum loads it as a <script> on every page, admin included" });
    } else {
      issues.push({ key, level: "warning", message: "loaded as a <script> from kit.fontawesome.com on every page, admin included; every visitor contacts that host (privacy/GDPR); prefer fontawesome_source: local" });
    }
  }
  if (key === "fontawesome_cdn_url" && value.trim()) {
    issues.push({ key, level: "warning", message: "every page (admin included) loads a stylesheet from that host: it can restyle or read out the page with CSS, and every visitor contacts it (privacy/GDPR); prefer the bundled Font Awesome (fontawesome_source: local)" });
  }
  if (key === "allow_user_color_scheme") {
    issues.push({ key, level: "warning", message: "Flarum 2.0 never reads this key; users may pick a scheme exactly when color_scheme is auto" });
  }
  return issues;
}

/** Static checks that catch the common custom_less failures before Flarum's trial compile. */
export function lintLess(less: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const code = stripLessComments(less);
  if (/data-uri\s*\(/i.test(code)) {
    issues.push({ key: "custom_less", level: "error", message: "data-uri() is refused by Flarum (ValidateCustomLess)" });
  }
  // less.php also accepts "@impor" and needs no space before the quote (core ValidateCustomLess checks "@impor").
  for (const m of code.matchAll(/@impor[t]?\s*(?:\([^)]*\)\s*)?(?:url\()?\s*["']?([^"');\s]+)/gi)) {
    const target = m[1];
    if (/^https:\/\//i.test(target) || /^http:\/\//i.test(target)) {
      issues.push({
        key: "custom_less",
        level: "warning",
        message: `remote @import ${target}: allowed by Flarum but every visitor's browser contacts that host (privacy/GDPR); prefer self-hosted files`,
      });
    } else if (target.startsWith("//")) {
      issues.push({ key: "custom_less", level: "error", message: `protocol-relative @import ${target} is refused by Flarum` });
    } else {
      issues.push({
        key: "custom_less",
        level: "error",
        message: `local @import ${target} is refused (only Flarum's own import dirs are allowed); inline the rules or use @font-face url()`,
      });
    }
  }
  // url() to another host: every visitor's browser contacts it (fonts, images from a CDN).
  for (const m of code.matchAll(/url\(\s*["']?((?:https?:)?\/\/[^"')\s]+)/gi)) {
    issues.push({ key: "custom_less", level: "warning", message: `url(${m[1]}) loads from another host for every visitor (privacy/GDPR); prefer files in the set's static/ folder` });
  }
  // less.php evaluates a / b in property values as division (grid-column: 1 / 3 -> 0.333).
  const division = /(grid-(?:column|row|area)|aspect-ratio|font)\s*:\s*[^;{}~"']*\d\s*\/\s*\d/i.exec(code);
  if (division) {
    issues.push({
      key: "custom_less",
      level: "warning",
      message: `"${division[0].trim()}" contains "a / b", which less.php may compute as a division; escape it as ~"1 / 3"`,
    });
  }
  const opens = (code.match(/{/g) ?? []).length;
  const closes = (code.match(/}/g) ?? []).length;
  if (opens !== closes) {
    issues.push({ key: "custom_less", level: "error", message: `unbalanced braces ({ ${opens} vs } ${closes})` });
  }
  return issues;
}

function stripLessComments(s: string): string {
  // Remove /* */ blocks and // line comments outside of strings/urls (good enough for linting).
  // A "//" only starts a comment at line start or after whitespace, ";", "{" or "}"
  // (never inside url(//host/…) or "https://…").
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}])\/\/[^\n]*/g, "$1");
}

/** Validate a whole settings write. */
export function checkSettingsWrite(
  values: Record<string, unknown>,
  opts: { enabledExtensions: string[]; allowProtected?: boolean; allowOther?: boolean },
): { normalised: Record<string, string | null>; issues: ValidationIssue[] } {
  const normalised: Record<string, string | null> = {};
  const issues: ValidationIssue[] = [];
  for (const [key, raw] of Object.entries(values)) {
    const cls = classifyKey(key, opts.enabledExtensions);
    if (cls === "forbidden") {
      issues.push({
        key,
        level: "error",
        message: !KEY_ALPHABET.test(key)
          ? "keys may only contain A-Z a-z 0-9 . _ - (the database ignores case, trailing spaces and accents)"
          : key !== key.toLowerCase() && ([...THEME_KEYS, ...OPTIONAL_DESIGN_KEYS] as string[]).includes(key.toLowerCase())
            ? `write it as "${key.toLowerCase()}": another spelling hits the same row but skips every value check`
          : /_path$|_size$/i.test(key)
            ? "image paths are managed by the upload endpoints; use flarum_upload_image / flarum_delete_image"
            : "managed by Flarum itself; writing it can break the forum",
      });
      continue;
    }
    if (cls === "protected" && !opts.allowProtected) {
      issues.push({ key, level: "error", message: "protected key (security/availability); requires allowProtected:true with explicit user approval" });
      continue;
    }
    if (cls === "other" && opts.allowOther === false) {
      issues.push({ key, level: "error", message: "not a known design key and not prefixed by an enabled extension id" });
      continue;
    }
    const value = normaliseValue(key, raw);
    issues.push(...validateValue(key, value));
    normalised[key] = value;
  }
  return { normalised, issues };
}

/**
 * Admin endpoints that have a dedicated operation with key policy, snapshot and read-back. The raw escape
 * hatches (MCP flarum_request, CLI `api`) refuse writes to them, so they cannot bypass the policy
 * (e.g. POST /settings {"extensions_enabled": ...}). Paths are API-relative, as normalizeApiPath returns them.
 */
const MANAGED_WRITES: { re: RegExp; mcp: string; cli: string }[] = [
  { re: /^\/settings$/, mcp: "flarum_settings_set / flarum_settings_reset", cli: "settings set|reset" },
  { re: /^\/extensions\/[^/]+$/, mcp: "flarum_extension_set", cli: "extension <id> on|off" },
  { re: /^\/permission$/, mcp: "flarum_permission_set", cli: "permission <name> <ids>" },
  { re: /^\/(logo|logo-dark-mode|email-logo|favicon)$/, mcp: "flarum_upload_image / flarum_delete_image", cli: "image upload|delete" },
  { re: /^\/cache$/, mcp: "flarum_cache_clear", cli: "cache clear" },
  // Creating or deleting API tokens: the created token would be handed to the agent. Not offered.
  { re: /^\/access-tokens(\/|$)/, mcp: "nothing (access tokens are not created or deleted here)", cli: "nothing (manage tokens in the forum)" },
  // POST /token answers with a new token in clear text; DELETE /sessions logs the admin out everywhere.
  { re: /^\/(token|sessions)$/, mcp: "nothing (log in with the CLI: flarum2-ops login)", cli: "login" },
  // Rotates extensions_enabled (core Bisect::rotateExtensions); deliberately not offered.
  { re: /^\/extension-bisect$/, mcp: "nothing (extension bisect is not offered)", cli: "nothing (extension bisect is not offered)" },
  // composer require/update/remove on the server: only through the opt-in flarum_ext_* tools.
  { re: /^\/extension-manager(\/|$)/, mcp: "the flarum_ext_* tools (FLARUM_EXTENSIONS=1)", cli: "nothing (use the MCP flarum_ext_* tools)" },
];

export function managedWrite(apiPath: string): { mcp: string; cli: string } | undefined {
  return MANAGED_WRITES.find((m) => m.re.test(canonicalApiPath(apiPath)));
}

/**
 * The route a path actually reaches, for policy checks: query/fragment dropped, dot segments resolved the way
 * fetch resolves them, percent-encoding decoded, repeated and trailing slashes collapsed. Errs on the side of
 * matching (a refused write is safe; a bypass is not).
 */
export function canonicalApiPath(apiPath: string): string {
  // The client sends `${apiRoot}${path}`; resolve it exactly like that, then make it API-relative again.
  let p = new URL(`http://x/api${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`).pathname;
  p = p === "/api" ? "/" : p.startsWith("/api/") ? p.slice(4) : p;
  try {
    p = decodeURIComponent(p);
  } catch {
    /* malformed escape: keep the raw path */
  }
  p = p.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return (p || "/").toLowerCase();
}
