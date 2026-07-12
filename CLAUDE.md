# CLAUDE.md

## What this is

A minimal **MCP (Model Context Protocol) server** that lets an AI agent query one or
more Graylog instances. Published to npm as `@jperelli/graylog-mcp` and run via
`npx`. Pure ESM Node.js, no build step.

## Layout

- `src/index.js` — the entire server. Single file: instance loading, tool schemas, and
  handlers all live here.
- `package.json` — `bin` maps `graylog-mcp` → `src/index.js` (has a `#!/usr/bin/env node` shebang).
- `README.md` — user-facing setup, tool reference, and design rationale.
- `example-config.json` — sample MCP client config.
- `test/` — `npm test` (`node --test test/*.test.js`). Dependency-free smoke tests, one
  file per tool (`list_streams`, `search`, `analyze`, `get_message`). `test/helpers.js`
  stands up a mock Graylog over `node:http` and launches `src/index.js` over stdio via the
  MCP client; each `*.test.js` file drives one tool against it. No live Graylog needed.

## Run / debug

```bash
GRAYLOG_BASE_URL_INSTANCE_1=http://host:9000 \
GRAYLOG_API_TOKEN_INSTANCE_1=<token> \
node src/index.js          # speaks MCP over stdio
```

Set `DEBUG=true` for verbose logging to stderr. The transport is stdio, so anything on
stdout that isn't a JSON-RPC frame breaks the protocol — log to **stderr** only
(`console.error`).

## Configuration model

Instances are configured via numbered env vars: `GRAYLOG_BASE_URL_INSTANCE_N`,
`GRAYLOG_API_TOKEN_INSTANCE_N`, and optional `GRAYLOG_LABEL_INSTANCE_N`. Instance 1 also
falls back to the legacy `BASE_URL` / `API_TOKEN`. Only instances with both URL and token
are active; the first is the default.

## Tools (all in `src/index.js`)

- `search` — read matching log lines; concise projection by default, `verbose`/`fields` for full, absolute `from`/`to` supported. On 0 matches it self-diagnoses (see below).
- `analyze` — top values of a field + optional time histogram; `valueContains` substring-matches the *values*.
- `list_fields` — which fields actually exist, filtered by `contains`.
- `list_streams` — readable stream IDs. Rarely needed; capped output.
- `get_message` — fetch one full document by `_id` + `_index`.

Cross-tool guidance (query syntax, stream-scoping, severity quirks) lives in the server-level
`instructions` string, not repeated per tool.

## Graylog specifics to remember

- Auth is HTTP Basic: username = API token, password = the literal `"token"`.
- Every request needs the `X-Requested-By` header or Graylog returns **403** (CSRF).
- Stream scoping is **mandatory** — a limited-permission token gets 403 on an unscoped
  search. Use the Default Stream id `000000000000000000000001` to search everything visible.
  Prefer it: a real cluster can have thousands of streams (nonprod has 1,205).
- **Graylog 6.0 removed the universal-search `/terms` and `/histogram` sub-resources.** They
  404 while the plain `/api/search/universal/{relative,absolute}` endpoints still work. So:
  - `search` uses the legacy endpoint (one stream per request, fanned out and merged).
  - `analyze` uses the Views API (`POST /api/views/search/sync`) — all streams in one
    request, no fan-out. Don't "restore" the old terms endpoints; the mock in `test/helpers.js`
    404s them on purpose so a regression fails loudly.
- **The Views API answers HTTP 200 even when the query failed**, with the reason in
  `results.q.errors`. Always check it, or a broken query reads as zero results.
- A stream the token can't read **403s the whole Views request** — but the body
  (`MissingStreamPermission`) names the offending streams, so `viewsSearchTolerant` drops
  them and retries once rather than failing. Both tools degrade partially, never fatally.
- **Elasticsearch rejects a leading wildcard** — `field:*foo*` is a hard error, not an empty
  result. Substring-matching a value therefore has to scan buckets and filter locally
  (that's what `analyze`'s `valueContains` does).
- **Indexing can lag ingestion by hours.** A message is only searchable once *processed*:
  compare `gl2_receive_timestamp` (arrival) with `gl2_processing_timestamp` (indexed). During
  a backlog a correct query over a recent window truthfully returns 0 matches — which reads
  as "the service produced no logs" and is the single most misleading failure here.
  `diagnoseEmpty` in `src/index.js` exists to catch exactly this: on 0 matches it checks
  whether the window holds anything, finds the newest *indexed* message, and reports the lag
  plus `/api/system/journal` backlog.
- **Severity has to be discovered, not guessed.** The shipper parses JSON log lines and
  extracts their keys into real fields: pino's `{"level":50,"msg":"Error","name":"SvcX"}`
  becomes fields `msg`/`name`, while its numeric `level` is *lost* — it collides with the
  container's `level` (7). So `level:ERROR` and `level:50` both match nothing while errors
  are plainly there; `msg:Error` and free-text `error` are the real handles (`exception`
  matches nothing on nonprod). This is why `msg`/`name`/`err`/`stack` are in `CONCISE_FIELDS`.
- **`analyze` on `msg` is the "what is failing" tool.** It collapses a thousand repeats of
  one error into one row. The equivalent `search` costs ~100× the context and says less —
  the tool descriptions and `instructions` push agents toward it deliberately.

## Conventions

- Keep it a single dependency-light ESM file; match the existing helper style
  (`textResult`/`jsonResult`/`errorResult`, per-tool `async function`).
- Bump `version` in `package.json` only — `src/index.js` reads it from there at startup (`new Server({ version })`), so there is a single source of truth. The publish workflow refuses to release if the git tag (`vX.Y.Z`) doesn't match `package.json`.
