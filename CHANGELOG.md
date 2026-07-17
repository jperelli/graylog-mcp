# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-07-16

Cosmetic semver issue sync mcp registry vs npmjs

[1.3.0]: https://github.com/jperelli/graylog-mcp/releases/tag/v1.3.0

## [1.2.0] - 2026-07-16

Support for mixed Graylog versions and searching across all streams.

### Fixed

- `analyze` now works on Graylog 4.2 as well as 6.x.
- Searches no longer assume the Default Stream contains every message.

### Added

- `search` and `analyze` accept `streams:"*"` to query every readable stream.
- `list_streams` reports each stream's `removes_from_default_stream` flag.
- Empty Default-Stream searches now suggest retrying with `streams:"*"`.

### Changed

- Server instructions now explain the wildcard query rules in full.

[1.2.0]: https://github.com/jperelli/graylog-mcp/releases/tag/v1.2.0

## [1.1.0] - 2026-07-12

General improvements to help minimize back and forth for simple errors or bad searches.

### Fixed

- `analyze` no longer returns 404 on Graylog 6.x.
- `list_streams` no longer returns a huge response on clusters with many streams.
- Failed queries that Graylog reports with HTTP 200 are now surfaced as errors.

### Added

- `list_fields` — list the message fields that exist, filtered by `contains`.
- `analyze` gains `valueContains` — substring-match a field's values.
- `list_streams` gains `limit` (default 50).
- `search` gains `messageChars` — max characters of the raw message body per hit.
- Empty results now carry `why_no_results`, including when Graylog has not indexed the logs yet.
- Error hints for leading wildcards and removed endpoints.

### Changed

- `search` now returns the parsed `name`, `msg`, `err` and `stack` fields in its concise projection.
- `search` truncates the raw message body at 500 chars instead of 2,000, cutting a typical response by 60%.
- `analyze` replaces `missing` and `other` with `total_matched` and `not_in_top_values`.
- `analyze` now skips unreadable streams, returning results for the rest plus `failed_streams`.
- Server instructions now teach discovering severity fields rather than guessing `level:ERROR`.

[1.1.0]: https://github.com/jperelli/graylog-mcp/releases/tag/v1.1.0

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
