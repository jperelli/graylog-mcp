# Graylog MCP Server

[![CI](https://github.com/jperelli/graylog-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/jperelli/graylog-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@jperelli/graylog-mcp.svg)](https://www.npmjs.com/package/@jperelli/graylog-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@jperelli/graylog-mcp.svg)](https://www.npmjs.com/package/@jperelli/graylog-mcp)
[![node](https://img.shields.io/node/v/@jperelli/graylog-mcp.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@jperelli/graylog-mcp.svg)](LICENSE)

A minimal MCP (Model Context Protocol) server in JavaScript that integrates with Graylog.

## Features

- JavaScript MCP server
- Tools: `search` (read matching log lines across multiple streams), `analyze` (aggregate matches by a field, with an optional time histogram), `list_fields` (which fields exist), `list_streams` (discover readable streams), and `get_message` (fetch one full document)
- **Empty results explain themselves.** A zero-match search reports whether the query is wrong, the window is quiet, or Graylog simply hasn't *indexed* the logs yet — three causes that otherwise look identical and send an agent in circles
- **Discovery over guessing.** `list_fields` and `analyze`'s `valueContains` let an agent look up real field names and values instead of inventing them, since a wrong guess returns 0 hits and reads as "no logs exist"
- Token-efficient by design, `search` returns a concise projection of high-signal fields by default; opt into full documents with `verbose`
- A server-level "instructions" manual teaches the client the query syntax, stream-scoping rules, and severity quirks up front
- Multi-instance support, query multiple Graylog servers from a single MCP server

## Requirements

- Node.js 18+

## Configuration

Configure one or more Graylog instances using numbered env vars:

| Variable | Required | Description |
|---|---|---|
| `GRAYLOG_BASE_URL_INSTANCE_N` | yes | Graylog base URL for instance N |
| `GRAYLOG_API_TOKEN_INSTANCE_N` | yes | API token for instance N |
| `GRAYLOG_LABEL_INSTANCE_N` | no | Human-readable label (default: `instance_N`) |

Replace `N` with `1`, `2`, `3`, … to register as many instances as needed. Only instances with both `BASE_URL` and `API_TOKEN` set will be active.

## Use with an MCP client

No installation needed, `npx` downloads and runs the server automatically.

### Claude Code

```bash
claude mcp add graylog-mcp \
  -e GRAYLOG_BASE_URL_INSTANCE_1=http://your-graylog-production.example.com:9000 \
  -e GRAYLOG_API_TOKEN_INSTANCE_1=your_production_token \
  -e GRAYLOG_LABEL_INSTANCE_1=production \
  -e GRAYLOG_BASE_URL_INSTANCE_2=http://your-graylog-staging.example.com:9000 \
  -e GRAYLOG_API_TOKEN_INSTANCE_2=your_staging_token \
  -e GRAYLOG_LABEL_INSTANCE_2=staging \
  -- npx -y @jperelli/graylog-mcp@latest
```

Or add it manually to `~/.claude.json`:

```json
{
  "mcpServers": {
    "graylog-mcp": {
      "command": "npx",
      "args": ["-y", "@jperelli/graylog-mcp@latest"],
      "env": {
        "GRAYLOG_BASE_URL_INSTANCE_1":  "http://your-graylog-production.example.com:9000",
        "GRAYLOG_API_TOKEN_INSTANCE_1": "your_production_token",
        "GRAYLOG_LABEL_INSTANCE_1":     "production",

        "GRAYLOG_BASE_URL_INSTANCE_2":  "http://your-graylog-staging.example.com:9000",
        "GRAYLOG_API_TOKEN_INSTANCE_2": "your_staging_token",
        "GRAYLOG_LABEL_INSTANCE_2":     "staging"
      }
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "graylog-mcp": {
      "command": "npx",
      "args": ["-y", "@jperelli/graylog-mcp@latest"],
      "env": {
        "GRAYLOG_BASE_URL_INSTANCE_1":  "http://your-graylog-production.example.com:9000",
        "GRAYLOG_API_TOKEN_INSTANCE_1": "your_production_token",
        "GRAYLOG_LABEL_INSTANCE_1":     "production",

        "GRAYLOG_BASE_URL_INSTANCE_2":  "http://your-graylog-staging.example.com:9000",
        "GRAYLOG_API_TOKEN_INSTANCE_2": "your_staging_token",
        "GRAYLOG_LABEL_INSTANCE_2":     "staging"
      }
    }
  }
}
```

### Claude Desktop

Config file locations:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/claude-desktop/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Use the same JSON structure shown above for Cursor.

---

## Use

Once configured, the tools become available and are called automatically when needed. The usual flow is to search the Default Stream (`000000000000000000000001`), which covers everything the token can read, then `analyze` to spot patterns, `search` to read individual lines, and `get_message` to inspect one hit in full. Reach for `list_streams` only to scope to a specific named stream. Example prompts:

```
Search Graylog for errors in the payments namespace in the last 15 minutes.
Query the "staging" instance.
```

```
Which containers produced the most errors in the last hour?
```

```
Which namespaces have "payments" in the name?
```

**Don't let the agent guess field names or values.** A query on a field or value that doesn't exist matches nothing, which looks exactly like "there are no logs". `list_fields` answers which fields exist, and `analyze` with `valueContains` answers which values a field actually has.


## Available tools

### list_streams

List the streams the configured API token can read (id + title). Only readable ones are returned.

You usually **don't need this**: pass the Default Stream id `000000000000000000000001` to `search`/`analyze` to cover everything the token can read. A cluster can hold thousands of streams (the author's has 1,205), so output is capped — use `titleContains` when you want one specific named stream.

Parameters:

- `instance` (string, optional): Label of the Graylog instance to query. Defaults to the first configured instance.
- `titleContains` (string, optional): Case-insensitive substring filter on the stream title (e.g. `catalogue`).
- `limit` (number, optional): Max streams to return. Default: `50`. The Default Stream is always included and never counts against the cap.

### list_fields

List the message fields that actually exist in the index. Use it **before** searching on a field you haven't seen in a result, so you never guess a field name.

A cluster indexes thousands of fields (the author's: 3,269), and near-duplicates are common — `namespace_name`, `Pod_namespace`, `pod_namespace` and `Namespace` may all exist while only one is populated by your shipper. Pass `contains` to narrow.

Parameters:

- `contains` (string, optional): Case-insensitive substring filter on the field name, e.g. `namespace`, `pod`, `level`.
- `limit` (number, optional): Max field names to return. Default: `100`.
- `instance` (string, optional): Instance label. Defaults to the first configured instance.

### search

Read matching log lines across one or more streams, merged newest-first. By default it returns a **concise projection** of high-signal fields (`timestamp`, `source`, `level`, `container_name`, `pod_name`, `namespace_name`, `application_name`, `service`, `logger_name`, `name`, `msg`, `err`, `stack`, `message`) plus each hit's `_id`/`_index`, with the raw `message` body truncated to 500 chars, this keeps the agent's context small. Set `verbose: true` (or pass explicit `fields`) to get every populated field, untruncated. Stream IDs are **required**, an all-streams search is not performed implicitly, because a limited-permission token would be rejected with `403 Not authorized`.

`name`/`msg`/`err`/`stack` are there because a shipper that parses a JSON log line (pino, bunyan, structlog) extracts its keys into real fields. Those fields *are* the summary of the event, and they're cheap — the raw `message` body that contains them is neither, which is why it's truncated hard by default.

> **Reach for `analyze` before `search`.** Raw lines are the most expensive thing this server returns. A hundred repetitions of one error cost a hundred times as much via `search` as one aggregated row via `analyze`, and tell you less. Use `search` once you know which line you want.

> **Tip:** to search everything the token can see (including messages not routed to a named stream), pass the Default Stream id `000000000000000000000001`. `list_streams` also surfaces it.

Parameters:

- `query` (string, **required**): Search query, using Graylog/Elasticsearch syntax. Examples: `msg:Error`, `namespace_name:app-payments-qa AND error`, `source:api-*`, `*`.
- `streams` (string, **required**): Comma-separated stream IDs to search. Get them from `list_streams`.
- `instance` (string, optional): Label of the Graylog instance to query. Defaults to the first configured instance.
- `searchTimeRangeInSeconds` (number, optional): Relative time range in seconds. Default: `900` (15 minutes).
- `from` / `to` (string, optional): Absolute window in ISO-8601 UTC (e.g. `2026-07-11 14:00:00`). When both are set they override the relative range, use them to investigate a known incident window.
- `searchCountLimit` (number, optional): Max number of messages. Default: `50`.
- `messageChars` (number, optional): Max characters of the raw message body per hit. Default: `500`. Raise it only when the detail you need lives in the raw body rather than the parsed fields.
- `verbose` (boolean, optional): Return every populated field, untruncated, instead of the concise projection. Default: `false`.
- `fields` (string, optional): Comma-separated explicit field list to return. Overrides the concise projection.

The response is `{ returned, total_matched, streams, messages, note?, projection?, why_no_results? }`, where `total_matched` is the total number of hits across the streams (may exceed `returned`, which is capped by `searchCountLimit`); when it does, `note` explains how to see more.

**When a search matches nothing, it tells you why.** A bare `total_matched: 0` is ambiguous, and the three causes need opposite responses, so `why_no_results` names the one that applies:

- *The window has messages, but none match.* The streams and time range are fine, so the query is wrong — usually a guessed field name or value. Confirm with `list_fields` / `analyze`.
- *The window is empty, and indexing is current.* These streams are genuinely quiet.
- *The window is empty, and the newest indexed message is hours old.* **Graylog is still indexing.** The logs exist and have been received; they just aren't searchable yet. The response reports how far behind indexing is and the journal backlog. Don't conclude the logs are missing — widen the range or retry.

That last case is easy to misread as "this service produced no logs", and it's the reason this project exists in its current shape: the pipeline can lag ingestion by hours under load.

> **Note on log levels — severity must be discovered, not guessed.** Some services emit a top-level Graylog `level` (syslog: 3=error, 4=warn). Others log JSON, and the shipper extracts its keys into their *own* fields: pino's `{"level":50,"msg":"Error","name":"SvcX"}` typically becomes fields `msg` and `name`, while its numeric `level` is **lost** — it collides with the container's own `level` (often `7`), so `level:50` and `level:ERROR` both match **nothing** even though the errors are plainly there. Guessing a disjunction like `level:ERROR OR level:50 OR error OR exception OR fatal` is how agents waste turns. Instead run `list_fields` (`contains: "level"`, `"msg"`, `"err"`), then `analyze` on `msg` to see the actual values. Free-text `error` works as a fallback; don't assume `exception` or `fatal` exist. And avoid `"level":50` as a query, a quoted string before `:` is invalid Lucene.

### analyze

Aggregate matching messages by the **top values of a field** instead of returning raw lines, e.g. which `source`, `container_name`, or `level` dominates the errors in a window. Optionally add a **time histogram** of total match volume. Two uses:

1. **Find what is failing.** Aggregate on a message field (`msg`, or whatever short summary field `list_fields` reveals) to collapse a thousand repetitions of one error into a single row with a count; on `name` / `container_name` / `source` to see who is emitting them. This is the fastest route from "is anything weird?" to an answer — and it costs a few hundred tokens where the equivalent `search` costs tens of thousands:

   ```
   analyze field:msg    → 1386  Error
                            60  rabbitmq pub/sub: publishing to …exchange failed
   analyze field:name   → 1290  CatalogueService
                            96  ShippingService
   ```

2. **Discover a value before filtering on it.** Set `valueContains` to find the exact name of a namespace/pod/service you only half-know. Elasticsearch rejects a leading wildcard, so `namespace_name:*catalogue*` is a hard error, not an empty result — this is the only way to substring-match a value.

Parameters:

- `field` (string, **required**): Field to break down by, e.g. `source`, `namespace_name`, `container_name`, `level`. Confirm it exists with `list_fields` if you haven't seen it in a result.
- `streams` (string, **required**): Comma-separated stream IDs, or the Default Stream id.
- `query` (string, optional): Lucene filter applied before aggregating. Default: `*`.
- `valueContains` (string, optional): Case-insensitive substring filter on the returned **values**, applied locally over a wide bucket scan.
- `instance` (string, optional): Instance label. Defaults to the first configured instance.
- `searchTimeRangeInSeconds` (number, optional): Relative range in seconds. Default: `900`. Or use `from`/`to` for an absolute window.
- `size` (number, optional): Number of top values to return. Default: `20`.
- `histogramInterval` (string, optional): One of `minute`, `hour`, `day`, `week`, `month`. When set, the response also includes a time histogram of match counts.

The response is `{ field, query, streams, total_matched, top_values: [{ value, count }], not_in_top_values, histogram?, note?, warning?, failed_streams?, why_no_results? }`, where `not_in_top_values` counts matches that the returned values don't account for — messages with no value for the field, plus any bucket past the cut-off.

A stream the token can't read is **skipped, not fatal**: you get the aggregation over the readable streams plus `failed_streams` and a `warning` naming the ones excluded, in the same response.

> Implemented on Graylog's **Views/Aggregations API** (`POST /api/views/search/sync`), which takes every stream in a single request. The legacy `search/universal/*/terms` and `/histogram` endpoints this originally used were **removed in Graylog 6.0** and return `404` there.

### get_message

Fetch the full, untruncated document for a single message by its `_id` and `_index` (both returned by `search`). Use it after a concise `search` to inspect one hit in detail without pulling every result verbose.

Parameters:

- `messageId` (string, **required**): The `_id` from a search result.
- `index` (string, **required**): The `_index` from a search result.
- `instance` (string, optional): Instance label. Defaults to the first configured instance.

## Design rationale

The tools here are shaped around published guidance on building MCP servers that AI agents can actually use well, rather than mirroring the Graylog REST API one endpoint at a time. The key ideas and where they come from:

- **Design for the agent's task, not the API surface, fewer, outcome-oriented tools.** David Cramer (Sentry) makes the case that most MCP servers are still weak because they wrap raw endpoints instead of the jobs an agent needs to do; Sentry ships a curated, modest toolset instead. So this server exposes four task-shaped tools (discover → aggregate → read → drill in), not a wrapper per endpoint.
, David Cramer, [*MCP Is Not Good Yet*](https://www.youtube.com/watch?v=FCi4jT86gSw) · [*Yes, Sentry has an MCP Server (…and it's pretty good)*](https://blog.sentry.io/yes-sentry-has-an-mcp-server-and-its-pretty-good/)

- **Return high-signal context and protect the token budget.** Anthropic's guidance is that tools should return concise, relevant results and support filtering/truncation/pagination rather than dumping raw data into the model's context. Hence `search` returns a concise projection by default (with `verbose` and `get_message` as opt-in escalation) and emits a `note` when results are capped.
, Anthropic, [*Writing effective tools for agents*](https://www.anthropic.com/engineering/writing-tools-for-agents)

- **Pair raw retrieval with an aggregation/analysis tool.** New Relic's logging MCP does not only list log lines; it offers keyword search plus an analysis tool that surfaces error patterns and recurring issues. `analyze` fills that role for Graylog (top values of a field + optional histogram) so an agent can find patterns cheaply before reading individual lines.
, New Relic, [*MCP tool reference*](https://docs.newrelic.com/docs/agentic-ai/mcp/tool-reference/)

- **Put the "user manual" in server instructions, not in every tool description.** The MCP project recommends a top-level `instructions` field for cross-tool workflow, constraints, and quirks, keeping individual tool descriptions tight. This server's `instructions` teach the query syntax, the mandatory stream-scoping rule (a limited token gets `403` otherwise), and the pino numeric-severity gotcha once, up front.
, Model Context Protocol, [*Server Instructions: Giving LLMs a user manual for your server*](https://blog.modelcontextprotocol.io/posts/2025-11-03-using-server-instructions/)

## Troubleshooting

- Ensure at least `GRAYLOG_BASE_URL_INSTANCE_1` and `GRAYLOG_API_TOKEN_INSTANCE_1` are set.
- Verify Node.js 18+ is installed.
- Set `DEBUG=true` in the env to enable verbose logging to stderr.

## Credits

Current implementation by Julian Perelli. Based on previous work from Leo Ruellas, [lcaliani/graylog-mcp](https://github.com/lcaliani/graylog-mcp).

## License

MIT
