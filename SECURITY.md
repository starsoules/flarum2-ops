# Security policy

## Supported versions

Only the latest release on the `main` branch receives fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
[Report a vulnerability](https://github.com/starsoules/flarum2-ops/security/advisories/new). Do not open a public issue.

You can expect a first reply within a few days. Once a fix is available, the advisory is published with
credit to the reporter unless you prefer to stay anonymous.

## Scope notes

flarum2-ops acts on a forum with an admin token. The token is read from a file (mode 0600) and never written
to output, logs or process arguments; the settings reader opens a read-only database session and redacts
secret-looking keys. Reports about any way to make the tools reveal the token, write outside the forum's
`public/assets/design-sets/` folder, or bypass the dry-run/confirm gate are especially welcome.

What leaves the machine besides requests to the configured forum: the docs tools (on by default, `FLARUM_DOCS=0`
turns them off) send search queries to Flarum's Algolia index and fetch pages from raw.githubusercontent.com, with
the generic flarum2-ops User-Agent. Screenshots load the forum's pages, including any third-party resources they
embed, in a sandboxed headless Chromium. Log lines returned to the agent have e-mail addresses and IPs masked.
