// Shared test harness for the graylog-mcp tool tests.
//
// No live Graylog needed: `startHarness` stands up a tiny mock of the Graylog
// REST API, launches the real server (src/index.js) over stdio via the MCP
// client, and returns a `call(tool, args)` helper that returns the tool's
// parsed JSON payload. One file per tool under test/ shares this harness.

import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER_PATH = fileURLToPath(new URL("../src/index.js", import.meta.url));

export const DEFAULT_STREAM_ID = "000000000000000000000001";

// --- get_message / analyze fixtures -----------------------------------------
export const MESSAGE_ID = "abc-123";
export const MESSAGE_INDEX = "graylog_0";
export const FULL_MESSAGE = { _id: MESSAGE_ID, source: "api-1", level: 3, message: "boom" };
export const TERMS = { "api-1": 7, "api-2": 3 };

// --- list_streams fixtures --------------------------------------------------
// Returned unsorted and without the default stream, so the server must inject
// the default stream and sort by title.
export const STREAMS = [
  { id: "s-zeta", title: "Zeta", description: "z", disabled: false },
  { id: "s-alpha", title: "Alpha", description: "a", disabled: false },
];

// --- search fixtures --------------------------------------------------------
// A message body longer than the 2000-char projection cap, to prove truncation.
export const LONG_BODY = "x".repeat(2500);
// Keyed by stream id. s2 is newer than s1 so the merge must place it first.
// s1 carries a non-high-signal field (extra_field) that the concise projection
// must drop.
export const SEARCH_HITS = {
  s1: {
    total: 1,
    messages: [
      {
        index: "idx_s1",
        message: {
          _id: "m-s1",
          timestamp: "2026-07-11T10:00:00.000Z",
          source: "api-1",
          level: 3,
          message: "older line",
          extra_field: "should-be-dropped-by-concise",
        },
      },
    ],
  },
  s2: {
    total: 5, // total_results > returned, to trigger the `note`
    messages: [
      {
        index: "idx_s2",
        message: {
          _id: "m-s2",
          timestamp: "2026-07-11T11:00:00.000Z",
          source: "api-2",
          level: 6,
          message: LONG_BODY,
        },
      },
    ],
  },
};

// Absolute-window search hit, served only from the /absolute endpoint. Its
// distinct _id proves an ISO from/to request routes there, not to /relative.
export const ABSOLUTE_HIT = {
  index: "idx_abs",
  message: {
    _id: "m-abs",
    timestamp: "2026-07-01T00:00:00.000Z",
    source: "api-abs",
    message: "from the absolute window",
  },
};

// analyze histogram buckets (unix-second timestamp -> count). Summed per stream.
export const HISTOGRAM = { 1751328000: 3, 1751331600: 5 };

// Mock Graylog REST API: answers only the paths the four tools reach. A stream
// id of "forbidden" returns 403 so we can exercise the partial fan-out path.
// Anything unexpected 404s so a stray request fails loudly.
function startMockGraylog() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (obj, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    const path = url.pathname;

    // analyze — terms aggregation
    if (path === "/api/search/universal/relative/terms") {
      return json({ terms: TERMS, missing: 1, other: 2, total: 12 });
    }

    // analyze — time histogram (only when histogramInterval is set)
    if (path === "/api/search/universal/relative/histogram") {
      return json({ results: HISTOGRAM });
    }

    // search — universal relative messages, one stream per request
    if (path === "/api/search/universal/relative") {
      const streamId = (url.searchParams.get("filter") ?? "").replace("streams:", "");
      if (streamId === "forbidden") {
        return json({ message: "Not authorized" }, 403);
      }
      const hit = SEARCH_HITS[streamId] ?? { total: 0, messages: [] };
      return json({ messages: hit.messages, total_results: hit.total });
    }

    // search — absolute (ISO from/to) window. Requires both bounds echoed
    // as query params, and returns a hit distinct from the relative endpoint.
    if (path === "/api/search/universal/absolute") {
      assert.ok(
        url.searchParams.get("from") && url.searchParams.get("to"),
        "absolute search must send from and to",
      );
      const streamId = (url.searchParams.get("filter") ?? "").replace("streams:", "");
      const messages = streamId === "s1" ? [ABSOLUTE_HIT] : [];
      return json({ messages, total_results: messages.length });
    }

    // list_streams — readable streams (default stream omitted, as real Graylog does)
    if (path === "/api/streams") {
      return json({ streams: STREAMS });
    }
    // list_streams — default stream lookup for injection
    if (path === `/api/streams/${DEFAULT_STREAM_ID}`) {
      return json({
        id: DEFAULT_STREAM_ID,
        title: "All messages",
        description: "Default stream",
        disabled: false,
      });
    }

    // get_message — full document
    if (path === `/api/messages/${MESSAGE_INDEX}/${MESSAGE_ID}`) {
      return json({ index: MESSAGE_INDEX, message: FULL_MESSAGE });
    }

    return json({ error: `unexpected ${req.method} ${path}` }, 404);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

// Pull the tool's JSON payload out of an MCP CallTool result.
function parseToolJson(result) {
  assert.ok(!result.isError, `tool returned an error: ${JSON.stringify(result)}`);
  const text = result.content?.find((c) => c.type === "text")?.text;
  assert.ok(text, "tool result had no text content");
  return JSON.parse(text);
}

// Start the mock Graylog and a connected MCP client pointed at the real server.
// Returns `call(tool, args)` (parsed JSON payload) and `close()` for teardown.
export async function startHarness() {
  const { server, baseUrl } = await startMockGraylog();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: {
      ...getDefaultEnvironment(),
      GRAYLOG_BASE_URL_INSTANCE_1: baseUrl,
      GRAYLOG_API_TOKEN_INSTANCE_1: "test-token",
    },
  });
  const client = new Client({ name: "graylog-mcp-smoke-test", version: "1.0.0" });
  await client.connect(transport);

  return {
    async call(name, args = {}) {
      return parseToolJson(await client.callTool({ name, arguments: args }));
    },
    async close() {
      await client.close().catch(() => {});
      await new Promise((r) => server.close(r));
    },
  };
}
