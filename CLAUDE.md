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

- `list_streams` — discover readable stream IDs (call first).
- `search` — read matching log lines; concise projection by default, `verbose`/`fields` for full, absolute `from`/`to` supported.
- `analyze` — top values of a field (terms aggregation) + optional time histogram.
- `get_message` — fetch one full document by `_id` + `_index`.

Cross-tool guidance (query syntax, stream-scoping, severity quirks) lives in the server-level
`instructions` string, not repeated per tool.

## Graylog specifics to remember

- Auth is HTTP Basic: username = API token, password = the literal `"token"`.
- Every request needs the `X-Requested-By` header or Graylog returns **403** (CSRF).
- Stream scoping is **mandatory** — a limited-permission token gets 403 on an unscoped
  search. Use the Default Stream id `000000000000000000000001` to search everything visible.
- Tools use the **legacy** universal-search API (`/api/search/universal/{relative,absolute}[/terms|/histogram]`),
  which fans out one stream per request and is merged in code. It is deprecated in newer
  Graylog in favor of the Views/Aggregations API.
- Some services (e.g. pino) log severity as a numeric field *inside* the JSON body
  (`{"level":50}`), not the top-level Graylog `level`; `level:ERROR` may miss those.

## Conventions

- Keep it a single dependency-light ESM file; match the existing helper style
  (`textResult`/`jsonResult`/`errorResult`, per-tool `async function`).
- Bump `version` in `package.json` only — `src/index.js` reads it from there at startup (`new Server({ version })`), so there is a single source of truth. The publish workflow refuses to release if the git tag (`vX.Y.Z`) doesn't match `package.json`.
