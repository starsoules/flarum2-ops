# flarum2-ops: MCP server + CLI

One engine, two front ends. Source: `<repo>/tools/flarum2-ops` (TypeScript, fork of mcp-for-flarum 0.8.0, MIT;
see its NOTICE). `<repo>` = the root of the flarum2-ops repository (the folder with `forum.json`).

## Configuration
`<repo>/forum.json` (no secrets): `name`, `base_url`, `forum_root`, `token_file`, `design_sets_dir`,
`public_assets_subdir`, optional `services` (default nginx, php8.4-fpm, mariadb; health counts a unit that is not
`active` as a problem, which rolls an apply back, so list the units this host really runs, or `[]`; without
`systemctl` the check is only a warning).
Server switches (MCP): `FLARUM_MODE=write` (else read-only), `READ_ONLY=1` (forces read-only),
`FLARUM_EXTENSIONS=1` (extension-manager tools, off by default), `FLARUM_DOCS=0`, `FLARUM_DEV=0`,
`FLARUM_TROUBLESHOOT=0` (turn those tool groups off), `MCP_TRANSPORT=http` / `--http`, `PORT`, `HOST`,
`MCP_AUTH_TOKEN`, `MCP_ALLOWED_HOSTS` (see HTTP transport below).
Environment overrides: `FLARUM_URL`, `FLARUM_ROOT`, `FLARUM_TOKEN_FILE`, `FLARUM_API_KEY` (wins over the file),
`FLARUM_DESIGN_SETS_DIR`, `FLARUM_SERVICES`, `FLARUM_USER_ID` (act as this user with a master API key),
`FLARUM_USER_AGENT`, `FLARUM_TIMEOUT` (ms), `FLARUM2_OPS_CONFIG` (another forum.json; without any forum.json the
environment alone configures the tool), `FLARUM2_OPS_PYTHON`
(Python with Playwright for screenshots; default `python3`), `FLARUM2_OPS_SETTINGS_TIMEOUT_MS` (settings writes, default 300000: Flarum compiles LESS before it stores, and a
write the client gave up on can still land), `FLARUM2_OPS_LATE_WRITE_WAIT_MS` (after such a timeout the automatic
rollback waits this long, default 15000, and undoes a late write too), `FLARUM2_OPS_CHROMIUM_SANDBOX=0` (run the screenshot browser without Chromium's sandbox, only for containers
without user namespaces), `FLARUM2_OPS_SCREENSHOT_TIMEOUT_MS` (kill the
screenshot helper after this long; default 15 min, the preview then rolls back).

Interrupts: Ctrl+C, SIGTERM (the MCP host stopping the server) or SIGHUP (terminal/SSH gone) during an apply or
preview stops the screenshot helper, lets it roll back, then exits (130/143/129); a settings or image write runs to
its end first. A preview takes minutes (one browser load per page × scheme × viewport): give the tool call a long
timeout and do not kill it; afterwards check `doctor`. A second signal exits at once; `doctor` then
reports the interrupted write and names its pre-write snapshot.

## Credential
`bash <skill-dir>/scripts/ops.sh login` must be run **by the user in a normal terminal window** (Claude Code
`!` commands and pipes have no keyboard input; the CLI refuses them with exit 2). Over plain http to a host
other than this machine it refuses too (the password would cross the network in clear text) unless
`--allow-insecure-http` is given. It asks for
username/email and a hidden password, calls `POST /api/token` with `remember=1`, writes the token to
`~/.config/flarum2/token` (directory 0700, file 0600) and checks admin rights. The token is never printed,
never put in argv, and redacted from error output. To revoke: delete the file (and log out of the forum to
invalidate the token server-side, or change the password, which deletes all tokens).

## CLI
`bash <skill-dir>/scripts/ops.sh <command>` (resolves the real repo path even through the skill symlink).
JSON on stdout, messages on stderr. Exit codes: **0** ok · **1** error/blocked by validation (also `designset validate` with errors) · **2** usage ·
**3** dry run (nothing changed; repeat with `--confirm` after approval). `--compact` for one-line JSON.
`ops.sh help` lists every command. `ops.sh api GET /tags` is the raw escape hatch (non-GET needs `--confirm`;
writes to `/settings`, `/extensions/{id}`, `/permission`, the image routes, `/cache`, `/extension-bisect`,
`/extension-manager/*`, `/access-tokens`, `/token` and `/sessions` are refused, in any spelling; use their commands).

## MCP
Registered for the forum project in `<forum>/.mcp.json` as `flarum2-ops`, started by
`<repo>/tools/flarum2-ops/run-mcp.sh`. Defaults: **read-only** (write tools are not even listed), extension
manager tools off. Write mode: set `FLARUM_MODE=write` in `.mcp.json` env (user decision); **every** mutating
tool then still returns a dry run (`dryRun: true`, `wouldSend`) unless called with `confirm: true`, including
`flarum_request` (non-GET), the content tools and the extension-manager tools. Tools are annotated
`destructiveHint` where appropriate. `flarum_request`, `flarum_create`, `flarum_update` and `flarum_delete` refuse
writes to `/settings`, `/extensions/{id}` (a DELETE there is core's uninstall with down-migrations), `/permission`,
the image routes, `/cache`, `/extension-bisect` and `/extension-manager/*`: use the dedicated tools, which apply
the key policy. `type`, `id` and extension ids must be single path segments.

Confirmed settings and image writes run under the design-set lock (refused while an apply, preview or rollback
runs), take a design-set snapshot first (returned as `snapshot` plus the `rollback` command; needs
`forum_root`; an error after the snapshot names it) and are verified by read-back (`verify`). A read-back that
does not match, or a failed cache clear after the write, is an error (CLI exit 1, MCP `isError`), not a success.
`flarum_settings_reset` applies the same key policy as `flarum_settings_set` (Flarum-managed keys never,
protected keys only with `allowProtected` / `--allow-protected`; a reset secret cannot be restored by rollback).
`flarum_permission_set` returns `previousGroupIds` and a `restore` command instead (permissions are not in
snapshots; `none` = no group). Extension enable/disable, also via `flarum_ext_toggle` and
`flarum_ext_install enable`, always goes through `flarum_extension_set` (warning, health check, read-back).

Tools (read): `flarum_doctor`, `flarum_health`, `flarum_whoami`, `flarum_settings_get`, `flarum_list`,
`flarum_get`, `flarum_search`, `flarum_request` (GET only in read mode), `designset_list`, `designset_validate`,
`designset_diff`, `designset_screenshot`, `designset_gallery`, `designset_snapshot`, `designset_new`, plus
`flarum_docs_*` (on by default, `FLARUM_DOCS=0` turns them off: searches go to Flarum's Algolia index
(`*.algolia.net`), pages come from raw.githubusercontent.com; both see the query and the generic flarum2-ops
User-Agent, never the forum's `FLARUM_USER_AGENT`), `flarum_dev`, `flarum_troubleshoot`.
`flarum_settings_get` and the `designset_apply/preview/rollback/prune_snapshots` tools exist only when
`forum_root` is set (they read the database and keep snapshots locally).
Tools (write mode): `flarum_settings_set`, `flarum_settings_reset`, `flarum_upload_image`,
`flarum_delete_image`, `flarum_cache_clear`, `flarum_extension_set`, `flarum_permission_set`,
`designset_apply`, `designset_preview`, `designset_rollback`, `designset_prune_snapshots`, `flarum_create`, `flarum_update`,
`flarum_delete`, `flarum_create_discussion`, `flarum_reply`.
With `FLARUM_EXTENSIONS=1` also: `flarum_ext_search`, `flarum_ext_tasks` (read) and `flarum_ext_why_not`,
`flarum_ext_install`, `flarum_ext_update`, `flarum_ext_remove`, `flarum_ext_toggle`, `flarum_ext_check_updates`,
`flarum_ext_bulk_update`, `flarum_ext_configure_composer` (write mode; composer runs on the server).

HTTP transport (`--http` or `MCP_TRANSPORT=http`, `POST /mcp`, `PORT`, `HOST`): binds 127.0.0.1 by default and
refuses any other interface without `MCP_AUTH_TOKEN` (bearer token). Without a token, only requests whose Host
(and Origin, if sent) is a loopback name are served, which blocks DNS-rebinding from web pages; behind a reverse
proxy list the public host names in `MCP_ALLOWED_HOSTS` (comma-separated).

Fixed compared with mcp-for-flarum 0.8.0: `/api/...` paths no longer turn into `/api/api/...`; responses carry
the HTTP status (204 is reported, not `""`); `DELETE /cache` NDJSON is parsed; multipart uploads exist; a
rejected token is reported instead of silently acting as guest; read-only is the default; per-call timeouts;
outdated help corrected (CSRF errors are 400; safe mode / `extension:disable` / `extension:bisect` exist;
2.0 is stable; daily log files `storage/logs/flarum-YYYY-MM-DD.log`).

## Maintenance
```bash
cd <repo>/tools/flarum2-ops
npm test          # builds (tsc) and runs the offline test suite against a mock Flarum 2 server
```
After a Flarum update: re-check `vendor/flarum/core/src/Api/routes.php`, `less/common/variables.less` and
`root.less` against references/api-endpoints.md and less-theming.md, then run `ops.sh doctor`.
