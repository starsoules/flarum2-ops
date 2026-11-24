# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0 the MCP tools, CLI commands and
design-set format may still change between minor versions.

## [0.1.0] - 2026-11-24

First release.

### Added

- MCP server (stdio and HTTP) and CLI for Flarum 2.0.x: JSON:API access, admin settings with a read-only
  database reader, image uploads, cache, extensions, permissions, health and doctor checks.
- Design-set engine: validate, diff, apply, preview with screenshots, rollback, snapshots, export, gallery.
  Static files are published under a content version.
- Agent skill `flarum2-design-ops` with references checked against the Flarum 2.0 source.

### Safety

- Every write is a dry run unless confirmed and runs under a lock, with a pre-write snapshot and read-back
  verification. Failed or interrupted writes (SIGINT, SIGTERM, SIGHUP) roll back automatically, including late
  writes that land after a timeout.
- Rollback restores settings, images and tags, keeps going after a failed step, and needs explicit flags for
  protected keys and for snapshots of another forum.
- The client follows no redirects, stays under the API root and masks access tokens. Admin endpoints with their
  own commands are refused through the generic tools.
- SVG and HTML checks catch scripts, event handlers, `javascript:` URLs and third-party resources.
- Screenshots run in Chromium's sandbox. Login refuses plain http to a remote host. Log lines handed to the
  agent mask e-mail addresses, IPs and the credential.

### Requirements

- Node.js 22+, PHP CLI with PDO; optional Python 3.9+ with Playwright for screenshots.

### Known limitations

- CI checks the screenshot helper only for syntax; it was run against a real Flarum 2 forum before this release.
- No automated check that the documentation lists every tool and option.

[0.1.0]: https://github.com/starsoules/flarum2-ops/releases/tag/v0.1.0
