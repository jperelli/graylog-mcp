# Graylog MCP Server

[![CI](https://github.com/jperelli/graylog-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/jperelli/graylog-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@jperelli/graylog-mcp.svg)](https://www.npmjs.com/package/@jperelli/graylog-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@jperelli/graylog-mcp.svg)](https://www.npmjs.com/package/@jperelli/graylog-mcp)
[![node](https://img.shields.io/node/v/@jperelli/graylog-mcp.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@jperelli/graylog-mcp.svg)](LICENSE)

A minimal MCP (Model Context Protocol) server in JavaScript that integrates with Graylog.

## Features

- JavaScript MCP server
- Tools: `list_streams` (discover readable streams), `search` (read matching log lines across multiple streams), `analyze` (aggregate matches by a field, with an optional time histogram), and `get_message` (fetch one full document)
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
claude mcp add graylog-mcp npx @jperelli/graylog-mcp@latest \
  -e GRAYLOG_BASE_URL_INSTANCE_1=http://your-graylog-production.example.com:9000 \
  -e GRAYLOG_API_TOKEN_INSTANCE_1=your_production_token \
  -e GRAYLOG_LABEL_INSTANCE_1=production \
  -e GRAYLOG_BASE_URL_INSTANCE_2=http://your-graylog-staging.example.com:9000 \
  -e GRAYLOG_API_TOKEN_INSTANCE_2=your_staging_token \
  -e GRAYLOG_LABEL_INSTANCE_2=staging
```

Or add it manually to `~/.claude.json`:

```json
{
  "mcpServers": {
    "graylog-mcp": {
      "command": "npx",
      "args": ["@jperelli/graylog-mcp@latest"],
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
      "args": ["@jperelli/graylog-mcp@latest"],
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

Once configured, the tools become available and are called automatically when needed. The usual flow is to list streams to find the relevant stream IDs, then `analyze` to spot patterns and/or `search` to read individual lines, and `get_message` to inspect one hit in full. Example prompts:

```
List the Graylog streams that mention "payments".
```

```
Search the payments streams for errors in the last 15 minutes.
Query the "staging" Graylog instance.
```

```
In the payments streams, which sources produced the most errors in the last hour?
```


## Available tools

### list_streams

List the streams the configured API token can read (id + title). Use this first to discover stream IDs for `search`. The token may only have access to a subset of streams; only readable ones are returned.

Parameters:

- `instance` (string, optional): Label of the Graylog instance to query. Defaults to the first configured instance.
- `titleContains` (string, optional): Case-insensitive substring filter on the stream title (e.g. `bocato`).

### search

Read matching log lines across one or more streams, merged newest-first. By default it returns a **concise projection** of high-signal fields (`timestamp`, `source`, `level`, `container_name`, `pod_name`, `namespace_name`, `application_name`, `service`, `logger_name`, `message`) plus each hit's `_id`/`_index`, with long `message` bodies truncated, this keeps the agent's context small. Set `verbose: true` (or pass explicit `fields`) to get every populated field, untruncated. Stream IDs are **required**, an all-streams search is not performed implicitly, because a limited-permission token would be rejected with `403 Not authorized`.

> **Tip:** to search everything the token can see (including messages not routed to a named stream), pass the Default Stream id `000000000000000000000001`. `list_streams` also surfaces it.

Parameters:

- `query` (string, **required**): Search query, using Graylog/Elasticsearch syntax. Examples: `level:ERROR`, `msg:Error`, `error OR exception`, `*`.
- `streams` (string, **required**): Comma-separated stream IDs to search. Get them from `list_streams`.
- `instance` (string, optional): Label of the Graylog instance to query. Defaults to the first configured instance.
- `searchTimeRangeInSeconds` (number, optional): Relative time range in seconds. Default: `900` (15 minutes).
- `from` / `to` (string, optional): Absolute window in ISO-8601 UTC (e.g. `2026-07-11 14:00:00`). When both are set they override the relative range, use them to investigate a known incident window.
- `searchCountLimit` (number, optional): Max number of messages. Default: `50`.
- `verbose` (boolean, optional): Return every populated field, untruncated, instead of the concise projection. Default: `false`.
- `fields` (string, optional): Comma-separated explicit field list to return. Overrides the concise projection.

The response is `{ returned, total_matched, streams, messages, note?, projection? }`, where `total_matched` is the total number of hits across the streams (may exceed `returned`, which is capped by `searchCountLimit`); when it does, `note` explains how to see more.

> **Note on log levels:** some services log severity as a numeric field *inside* the JSON message body (e.g. pino: `{"level":50}` = error, `40` = warn) rather than a top-level Graylog `level` field. For those, filter by message text (e.g. `msg:Error` or `error OR exception`) instead of `level:ERROR`. Avoid `"level":50` as a query, a quoted string before `:` is invalid Lucene.

### analyze

Aggregate matching messages by the **top values of a field** instead of returning raw lines, e.g. which `source`, `container_name`, or `level` dominates the errors in a window. Optionally add a **time histogram** of total match volume. Reach for this first during an incident: it's far cheaper on context than pulling raw rows, and it surfaces patterns directly.

Parameters:

- `field` (string, **required**): Field to break down by, e.g. `source`, `container_name`, `level`, `status_code`.
- `streams` (string, **required**): Comma-separated stream IDs. Get them from `list_streams`.
- `query` (string, optional): Lucene filter applied before aggregating. Default: `*`.
- `instance` (string, optional): Instance label. Defaults to the first configured instance.
- `searchTimeRangeInSeconds` (number, optional): Relative range in seconds. Default: `900`. Or use `from`/`to` for an absolute window.
- `size` (number, optional): Number of top values to return. Default: `20`.
- `histogramInterval` (string, optional): One of `minute`, `hour`, `day`, `week`, `month`. When set, the response also includes a time histogram of match counts.

The response is `{ field, query, streams, top_values: [{ value, count }], missing, other, histogram? }`, where `missing` counts matches with no value for the field and `other` counts matches beyond the returned top-N.

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
