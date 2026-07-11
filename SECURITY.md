# Security Policy

## Supported versions

Only the latest published version of `@jperelli/graylog-mcp` on npm receives
security fixes. Please upgrade before reporting an issue.

## Reporting a vulnerability

Please report security vulnerabilities **privately** — do not open a public
issue for anything exploitable.

- Preferred: use GitHub's [private vulnerability reporting](https://github.com/jperelli/graylog-mcp/security/advisories/new)
  ("Report a vulnerability" under the repository's **Security** tab).
- Alternatively, email **jperelli@gmail.com** with the details.

Please include a description, reproduction steps, and the impact. You can expect
an initial acknowledgement within a few days. Once a fix is released, we're happy
to credit you in the advisory unless you prefer to remain anonymous.

## How this server handles your credentials

This is a stdio MCP server that acts as a thin client to your own Graylog
instances. Understanding its data flow is the best way to reason about its
security:

- **API tokens are read only from environment variables**
  (`GRAYLOG_API_TOKEN_INSTANCE_N`, or the legacy `API_TOKEN`). They are never
  written to disk by this server.
- **Tokens are sent only to the Graylog base URL you configure**
  (`GRAYLOG_BASE_URL_INSTANCE_N`) — over HTTP Basic auth, as Graylog's token
  scheme requires — and to no other host. There is no telemetry, analytics, or
  outbound call to any third party.
- **Tokens are never logged.** Debug logging (`DEBUG=true`) goes to stderr and
  prints query metadata (stream counts, result counts), not credentials.
- **Log content flows to your MCP client.** Tool results — i.e. the Graylog log
  messages you query — are returned to the AI agent / client that invoked the
  tool. Only grant this server tokens whose stream access is appropriate to
  share with that client.

## Recommendations for operators

- Prefer an **HTTPS** Graylog base URL. HTTP Basic auth over plaintext HTTP
  exposes the token to anyone on the network path.
- Scope the API token to the **minimum set of streams** the agent needs. A
  limited-permission token both reduces blast radius and is the intended
  configuration (unscoped searches are rejected by Graylog with `403`).
- Rotate tokens periodically and whenever one may have been exposed.
