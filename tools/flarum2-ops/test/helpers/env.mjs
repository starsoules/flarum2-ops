// Environment for child processes (and for in-process calls that read process.env) in the offline suite.
//
// A developer shell that exports FLARUM_URL, FLARUM_API_KEY, FLARUM_ROOT, FLARUM2_OPS_CONFIG, MCP_AUTH_TOKEN,
// READ_ONLY, FLARUM_MODE, FLARUM_DESIGN_SETS_DIR or FLARUM_TOKEN_FILE must not change what a test does, and a test
// must never reach a real forum because of it. cleanEnv() takes process.env, drops every FLARUM* and MCP_*
// variable plus READ_ONLY, and lays `extra` on top (undefined values stay unset).
// FLARUM2_OPS_* is covered by the FLARUM prefix on purpose: tests that need such a variable pass it in `extra`.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Whether an inherited variable could steer flarum2-ops (or point it at a real forum). */
export function isSteering(name) {
  return name.startsWith("FLARUM") || name.startsWith("MCP_") || name === "READ_ONLY";
}

export function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!isSteering(k)) env[k] = v;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/**
 * Variables for code that calls loadConfig()/clientFromEnv(): a throw-away config file instead of the developer's
 * forum.json, and a token file that does not exist instead of ~/.config/flarum2/token.
 */
export function isolatedConfig() {
  const dir = mkdtempSync(join(tmpdir(), "flarum2-ops-isolated-"));
  const file = join(dir, "forum.json");
  writeFileSync(file, JSON.stringify({ name: "isolated-test-config", services: [] }));
  return { FLARUM2_OPS_CONFIG: file, FLARUM_TOKEN_FILE: join(dir, "no-such-token") };
}

/**
 * Run fn() with process.env replaced by cleanEnv(extra), then put the original variables back. For tests that call
 * clientFromEnv()/loadConfig() in their own process. The process.env object itself stays (no reassignment).
 */
export async function withCleanProcessEnv(extra, fn) {
  const saved = { ...process.env };
  const next = cleanEnv({ ...isolatedConfig(), ...extra });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, next);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}
