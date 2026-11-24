#!/usr/bin/env bash
# Run the flarum2-ops CLI that belongs to this skill.
# Works when the skill is reached through a symlink (e.g. <forum>/.claude/skills/flarum2-design-ops):
# the real location is resolved first, then ../../../tools/flarum2-ops/dist/cli.js is used.
#
# Usage: bash scripts/ops.sh <command> [args]     e.g.  bash scripts/ops.sh doctor
# Output: JSON on stdout. Exit 0 ok · 1 error · 2 usage · 3 dry run (re-run with --confirm after approval).
set -euo pipefail

self="$(readlink -f "${BASH_SOURCE[0]}")"
repo="$(cd "$(dirname "$self")/../../.." && pwd)"
cli="$repo/tools/flarum2-ops/dist/cli.js"

if [[ ! -f "$cli" ]]; then
    printf 'flarum2-ops CLI not found at %s\nBuild it: cd %s/tools/flarum2-ops && npm run build\n' "$cli" "$repo" >&2
    exit 1
fi
if ! command -v node >/dev/null 2>&1; then
    printf 'node is required (>= 18) but was not found in PATH\n' >&2
    exit 1
fi

# Use <repo>/forum.json when it exists; without it the CLI is configured by the environment (FLARUM_URL, …).
if [[ -z "${FLARUM2_OPS_CONFIG:-}" && -f "$repo/forum.json" ]]; then
    export FLARUM2_OPS_CONFIG="$repo/forum.json"
fi
# Screenshots need a Python with Playwright: use the first python3 in PATH that can import it (as run-mcp.sh does).
if [[ -z "${FLARUM2_OPS_PYTHON:-}" ]]; then
    while read -r py; do
        if "$py" -I -c "import playwright" >/dev/null 2>&1; then export FLARUM2_OPS_PYTHON="$py"; break; fi
    done < <(type -ap python3)
fi
exec node "$cli" "$@"
