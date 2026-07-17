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

// --- get_message fixtures ---------------------------------------------------
export const MESSAGE_ID = "abc-123";
export const MESSAGE_INDEX = "graylog_0";
export const FULL_MESSAGE = { _id: MESSAGE_ID, source: "api-1", level: 3, message: "boom" };

// --- analyze fixtures -------------------------------------------------------
// The Views API takes every stream in one request, so these are whole-result
// counts rather than per-stream ones to be summed.
export const TERMS = { "api-1": 14, "api-2": 6 };
// How many messages match the query. A pivot's rollup total counts these
// regardless of whether they carry the field being broken down — so a field that
// exists on none of them still reports a non-zero total, which is what lets
// analyze tell "wrong field name" apart from "no messages at all".
export const MATCHED_TOTAL = 1000;

// Values for a second field, used to exercise `valueContains` discovery: the
// caller knows "catalogue" but not the exact namespace.
export const NAMESPACES = {
  starrocks: 500,
  "app-sockshop-catalogue-dev": 275,
  "app-sockshop-catalogue-qa": 5,
  "istio-ingress": 100,
};

// analyze histogram buckets, keyed by the ISO bucket start the Views API returns.
export const HISTOGRAM = {
  "2026-07-01T00:00:00.000Z": 6,
  "2026-07-01T01:00:00.000Z": 10,
};

// --- list_fields fixtures ---------------------------------------------------
export const FIELDS = ["message", "namespace_name", "Pod_namespace", "source", "timestamp"];

// --- diagnoseEmpty fixtures -------------------------------------------------
// A query that matches nothing, so a zero-result search must explain itself.
export const EMPTY_QUERY = "no_such_field:nope";
// Stream whose window is empty but which HAS older indexed messages: the shape of
// a Graylog whose indexing has fallen hours behind ingestion.
export const STALE_STREAM = "stale";
export const STALE_TIMESTAMP = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
export const JOURNAL = {
  uncommitted_journal_entries: 4200,
  append_events_per_second: 900,
  read_events_per_second: 100,
};

// --- list_streams fixtures --------------------------------------------------
// Returned unsorted and without the default stream, so the server must inject
// the default stream and sort by title. Zeta removes its matches from the Default
// Stream (the routing option that makes a Default-Stream-only search miss it),
// Alpha does not — so list_streams must report the flag and the count.
export const STREAMS = [
  {
    id: "s-zeta",
    title: "Zeta",
    description: "z",
    disabled: false,
    remove_matches_from_default_stream: true,
  },
  {
    id: "s-alpha",
    title: "Alpha",
    description: "a",
    disabled: false,
    remove_matches_from_default_stream: false,
  },
];

// --- streams:"*" (all-streams search) fixtures ------------------------------
// A hit that lives ONLY in Zeta, which removes its matches from the Default
// Stream. So a Default-Stream-only search never sees it, but streams:"*" (which
// expands to every readable stream and queries them via the Views `messages`
// search type) must. Keyed by stream id.
export const WILDCARD_HIT = {
  index: "idx_zeta",
  message: {
    _id: "m-zeta",
    gl2_message_id: "m-zeta",
    timestamp: "2026-07-11T12:00:00.000Z",
    source: "bocato-1",
    namespace_name: "app-marketing-bocato-prod",
    msg: "validate failed",
    level: 3,
    extra_field: "dropped-by-concise",
  },
};
const VIEWS_MESSAGES = { "s-zeta": [WILDCARD_HIT] };

// --- search fixtures --------------------------------------------------------
// A message body longer than the projection cap, to prove truncation.
export const LONG_BODY = "x".repeat(2500);
// Keyed by stream id. s2 is newer than s1 so the merge must place it first.
// s1 carries a non-high-signal field (extra_field) that the concise projection
// must drop, plus the parsed-JSON fields (msg/name) a shipper extracts from a
// pino-style line — those are the summary and must survive the projection even
// though the raw body they came from gets truncated.
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
          msg: "Error",
          name: "CatalogueService",
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
  // The Default Stream holds infra logs (so a "*" probe finds the window is not
  // empty) but NOT the service the caller wants — the shape that makes
  // diagnoseEmpty steer a Default-Stream-only search toward streams:"*".
  [DEFAULT_STREAM_ID]: {
    total: 3,
    messages: [
      {
        index: "idx_def",
        message: { _id: "m-def", timestamp: "2026-07-11T09:00:00.000Z", source: "infra" },
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

// Build the pivot rows the Views API returns: one "leaf" row per bucket, then a
// trailing "non-leaf" rollup row carrying the grand total.
function pivotResult(id, buckets, total) {
  const rows = Object.entries(buckets).map(([key, count]) => ({
    key: [key],
    values: [{ key: ["count"], value: count, rollup: true, source: "row-leaf" }],
    source: "leaf",
  }));
  rows.push({
    key: [],
    values: [{ key: ["count"], value: total, rollup: true, source: "row-inner" }],
    source: "non-leaf",
  });
  return { id, type: "pivot", rows, total };
}

// Mock Graylog REST API: answers only the paths the tools reach, and behaves like
// Graylog 6 — the legacy universal-search terms/histogram sub-resources are GONE,
// so a regression back to them 404s here exactly as it does in production.
// A stream id of "forbidden" returns 403 to exercise the partial fan-out path.
function startMockGraylog() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (obj, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    const path = url.pathname;

    // analyze — Views/Aggregations API. Note it answers 200 even for a failed
    // query, with the reason in `errors`; the leading-wildcard case below is real
    // Elasticsearch behaviour and the server must surface it as an error.
    if (path === "/api/views/search/sync" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      return req.on("end", () => {
        const query = JSON.parse(body).queries[0];
        const queryString = query.query.query_string;
        const streams = query.filter.filters.map((f) => f.id);

        // Graylog's real 403 for this NAMES the streams it refused, which is what
        // lets the server drop them and retry rather than failing the whole call.
        const forbidden = streams.filter((s) => s === "forbidden");
        if (forbidden.length > 0) {
          return json(
            {
              type: "MissingStreamPermission",
              message:
                "The search is referencing at least one stream you are not permitted to see.",
              streams: forbidden,
            },
            403,
          );
        }
        // A bare `*` (match-all) is fine; a wildcard that OPENS a term is not.
        if (/(^|[:\s(])[*?]\S/.test(queryString)) {
          return json({
            execution: { done: true, cancelled: false, completed_exceptionally: true },
            results: {
              q: {
                errors: [
                  {
                    type: "search_type",
                    description:
                      "Elasticsearch exception [type=parse_exception, reason=parse_exception: " +
                      "'*' or '?' not allowed as first character in WildcardQuery].",
                  },
                ],
                search_types: {},
              },
            },
          });
        }

        // Graylog 4.2 only knows the SINGULAR `field` on a row_group and 400s on
        // the 6.x-only `fields` array. Emulate that so a regression back to
        // `fields` (which breaks the older prod cluster) fails loudly here.
        const badGroup = query.search_types.find(
          (st) => Array.isArray(st.row_groups) && st.row_groups[0] && "fields" in st.row_groups[0],
        );
        if (badGroup) {
          return json(
            {
              type: "ApiError",
              message: "Unable to map property fields.\nKnown properties include: field, limit, type",
            },
            400,
          );
        }

        const searchTypes = {};
        for (const st of query.search_types) {
          // Views `messages` search type — the streams:"*" search path. Gather the
          // hits for every stream in the filter, newest-first, capped to `limit`.
          if (st.type === "messages") {
            const hits = streams.flatMap((sid) => VIEWS_MESSAGES[sid] ?? []);
            hits.sort((a, b) =>
              String(b.message.timestamp ?? "").localeCompare(String(a.message.timestamp ?? "")),
            );
            searchTypes[st.id] = {
              id: st.id,
              type: "messages",
              messages: hits.slice(0, st.limit ?? 150),
              total: null,
            };
            continue;
          }
          const group = st.row_groups[0];
          // A pivot with NO row_groups is the grand-total rollup the "*" search
          // rides along with the messages type to report total_matched.
          if (!group) {
            const total = streams.reduce((n, sid) => n + (VIEWS_MESSAGES[sid]?.length ?? 0), 0);
            searchTypes[st.id] = pivotResult(st.id, {}, total);
            continue;
          }
          if (group.type === "time") {
            searchTypes[st.id] = pivotResult(st.id, HISTOGRAM, MATCHED_TOTAL);
          } else {
            const field = group.field;
            const buckets =
              field === "source" ? TERMS : field === "namespace_name" ? NAMESPACES : {};
            // An unknown field yields no buckets, but the messages still matched.
            searchTypes[st.id] = pivotResult(st.id, buckets, MATCHED_TOTAL);
          }
        }
        return json({
          execution: { done: true, cancelled: false, completed_exceptionally: false },
          results: { q: { errors: [], search_types: searchTypes } },
        });
      });
    }

    // list_fields — every indexed field name
    if (path === "/api/system/fields") {
      return json({ fields: FIELDS });
    }

    // diagnoseEmpty — ingest/indexing backlog
    if (path === "/api/system/journal") {
      return json(JOURNAL);
    }

    // search — universal relative messages, one stream per request
    if (path === "/api/search/universal/relative") {
      const streamId = (url.searchParams.get("filter") ?? "").replace("streams:", "");
      const query = url.searchParams.get("query");
      const range = Number(url.searchParams.get("range") ?? 0);
      if (streamId === "forbidden") {
        return json({ message: "Not authorized" }, 403);
      }
      // Indexing-lag shape: nothing in a recent window, but older messages exist.
      // diagnoseEmpty looks back 24h to find the newest thing actually indexed.
      if (streamId === STALE_STREAM) {
        if (range >= 86400) {
          return json({
            messages: [
              { index: "idx_stale", message: { _id: "m-stale", timestamp: STALE_TIMESTAMP } },
            ],
            total_results: 1,
          });
        }
        return json({ messages: [], total_results: 0 });
      }
      if (query === EMPTY_QUERY) {
        return json({ messages: [], total_results: 0 });
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
  const client = new Client({ name: "graylog-mcp-smoke-test", version: "1.1.0" });
  await client.connect(transport);

  return {
    async call(name, args = {}) {
      return parseToolJson(await client.callTool({ name, arguments: args }));
    },
    // The unparsed result. Error paths return prose rather than JSON, so tests
    // that assert on a failure message use this instead of `call`.
    async callRaw(name, args = {}) {
      return client.callTool({ name, arguments: args });
    },
    async close() {
      await client.close().catch(() => {});
      await new Promise((r) => server.close(r));
    },
  };
}
