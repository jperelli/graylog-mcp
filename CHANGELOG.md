# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-11

Initial release of `@jperelli/graylog-mcp`.

### Added

- `list_streams` — discover readable stream IDs, with title filter.
- `search` — read matching log lines, concise projection by default.
- `analyze` — top field values plus optional time histogram.
- `get_message` — fetch one full document by id/index.
- Multi-instance support via numbered environment variables.
- Server-level instructions manual teaching query syntax and quirks.
- Single-file ESM architecture, zero build step.
- Dependency-free smoke test covering the tools over stdio.
- Runs via `npx`, no install required.
- Actionable error hints steering the agent on failures.

[1.0.0]: https://github.com/jperelli/graylog-mcp/releases/tag/v1.0.0
