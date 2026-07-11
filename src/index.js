#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Single source of truth for the version — read from package.json so a release
// only bumps one file. `files` never lists package.json, but npm always ships it
// in the tarball, and ../package.json resolves both in-repo and once installed.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function loadInstances() {
  const declaredNumbers = Object.keys(process.env)
    .map((key) => key.match(/^GRAYLOG_BASE_URL_INSTANCE_(\d+)$/))
    .filter(Boolean)
    .map((match) => parseInt(match[1], 10))
    .sort((a, b) => a - b);

  const numbers = declaredNumbers.includes(1) ? declaredNumbers : [1, ...declaredNumbers];

  const instances = [];

  for (const i of numbers) {
    const baseUrl =
      process.env[`GRAYLOG_BASE_URL_INSTANCE_${i}`] ??
      (i === 1 ? process.env.BASE_URL : null) ??
      null;
    const apiToken =
      process.env[`GRAYLOG_API_TOKEN_INSTANCE_${i}`] ??
      (i === 1 ? process.env.API_TOKEN : null) ??
      null;
    const label = process.env[`GRAYLOG_LABEL_INSTANCE_${i}`] ?? `instance_${i}`;

    if (baseUrl && apiToken) {
      // Strip trailing slashes so we don't build "host//api/..." — Graylog
      // routes the double-slash path to its web UI (HTML) instead of the REST API.
      const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
      instances.push({ label, baseUrl: normalizedBaseUrl, apiToken });
    }
  }

  return instances;
}

const INSTANCES = loadInstances();

if (INSTANCES.length === 0) {
  console.error(
    "[graylog-mcp] No Graylog instances configured. " +
      "Set at least GRAYLOG_BASE_URL_INSTANCE_1 and GRAYLOG_API_TOKEN_INSTANCE_1.",
  );
}

const INSTANCE_BY_LABEL = {};
for (const inst of INSTANCES) {
  if (INSTANCE_BY_LABEL[inst.label]) {
    console.error(
      `[graylog-mcp] Warning: duplicate label "${inst.label}" — ` +
        `only the first instance with this label will be used. ` +
        `Check your GRAYLOG_LABEL_INSTANCE_N configuration.`,
    );
  } else {
    INSTANCE_BY_LABEL[inst.label] = inst;
  }
}

const DEFAULT_INSTANCE = INSTANCES[0] ?? null;
const ACTIVE_LABELS = INSTANCES.map((i) => i.label);
const DEFAULT_STREAM_ID = "000000000000000000000001";
const REQUEST_TIMEOUT_MS = 30000;

// Server "user manual" — cross-tool workflow, constraints, and Graylog quirks.
// Kept here (not duplicated into every tool description) per MCP guidance so it
// loads once into the client's context. See blog.modelcontextprotocol.io on
// server instructions.
const SERVER_INSTRUCTIONS = `Query logs from one or more Graylog instances.

Workflow: call \`list_streams\` first to discover stream IDs, then pass them to
\`search\` (raw messages) or \`analyze\` (aggregate counts). Use \`get_message\` to
fetch the full, untruncated document for a single hit returned by \`search\`.

Key constraints and quirks:
- Stream IDs are mandatory for search/analyze. There is no implicit all-streams
  search: a limited-permission token is rejected with 403. To search everything
  the token can see (including messages not routed to a named stream), use the
  Default Stream id "${DEFAULT_STREAM_ID}".
- Query syntax is Graylog/Elasticsearch Lucene: e.g. \`level:ERROR\`,
  \`source:api-*\`, \`error OR exception\`, \`*\` for everything. A quoted string
  before ':' (e.g. \`"level":50\`) is invalid Lucene — do not use it.
- Log severity is not uniform. Some services emit a top-level Graylog \`level\`
  field (syslog: 3=error, 4=warn); others (e.g. pino) log severity as a numeric
  field INSIDE the JSON body (\`{"level":50}\`=error, \`40\`=warn) that is not the
  Graylog level. When \`level:ERROR\` finds nothing, filter by text instead
  (\`error OR exception\`, \`msg:Error\`).
- \`search\` returns a concise projection of high-signal fields by default to
  save context. Pass \`verbose:true\` for every populated field, or \`fields\` for
  a specific set. Long message bodies are truncated unless verbose.
- To investigate a known incident, pass absolute \`from\`/\`to\` (ISO-8601 UTC)
  instead of the relative time range.`;

const server = new Server(
  {
    name: "graylog-mcp",
    version: pkg.version,
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: SERVER_INSTRUCTIONS,
  },
);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Authenticated GET against a Graylog instance, returning parsed JSON.
//
// Graylog's CSRF protection rejects API requests without X-Requested-By (403),
// and API tokens authenticate via HTTP Basic: username=<token>, password="token".
// Non-2xx responses throw an Error whose `.response` carries { status, data },
// matching the axios shape that errorResult reads.
async function graylogGet(instance, path, params = {}) {
  const url = new URL(instance.baseUrl + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }

  const auth = Buffer.from(`${instance.apiToken}:token`).toString("base64");
  let resp;
  try {
    resp = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Requested-By": "graylog-mcp",
        Authorization: `Basic ${auth}`,
      },
      // Fail fast on a hung or unreachable instance instead of blocking the tool call.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    if (cause?.name === "TimeoutError") {
      throw new Error(`Request to ${instance.label} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw cause;
  }

  // Graylog usually answers JSON, but error pages can be HTML/plain text — read
  // the body once as text and parse opportunistically so errorResult can surface it.
  const raw = await resp.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!resp.ok) {
    const err = new Error(`Request failed with status code ${resp.status}`);
    err.response = { status: resp.status, data };
    throw err;
  }
  return data ?? {};
}

function resolveInstance(args) {
  const requestedLabel = args.instance ?? DEFAULT_INSTANCE?.label;
  const instance = INSTANCE_BY_LABEL[requestedLabel] ?? null;
  if (instance) return { instance };

  const available =
    ACTIVE_LABELS.length > 0
      ? `Available instances: ${ACTIVE_LABELS.join(", ")}.`
      : "No instances are configured. Set GRAYLOG_BASE_URL_INSTANCE_N and GRAYLOG_API_TOKEN_INSTANCE_N.";
  return { error: textResult(`Graylog instance "${requestedLabel}" not found. ${available}`) };
}

function textResult(text) {
  return { content: [{ type: "text", text: String(text) }] };
}

function jsonResult(obj) {
  return textResult(JSON.stringify(obj, null, 2));
}

function errorResult(instance, action, error) {
  const status = error.response?.status;
  const body = error.response?.data;
  const detail = typeof body === "string" ? body.slice(0, 800) : JSON.stringify(body);
  console.error(
    `[graylog-mcp] Error ${action} (instance=${instance.label}):`,
    status,
    error.message,
  );

  // Steer the agent toward the next useful action instead of just reporting a code.
  let hint = "";
  if (status === 403) {
    hint =
      "\nHint: the token likely lacks read access to one of the requested streams. " +
      "Call list_streams to see which streams this token can read, and search only those.";
  } else if (status === 400) {
    hint =
      "\nHint: the query may be invalid Lucene. Avoid a quoted string before ':' " +
      '(e.g. "level":50); try `error OR exception` or `*` to confirm connectivity.';
  }

  return textResult(
    `Error ${action} on instance "${instance.label}": ${error.message}` +
      (status ? ` (HTTP ${status})` : "") +
      (detail && detail !== "undefined" ? `\nResponse body: ${detail}` : "") +
      hint,
  );
}

function parseStreams(raw) {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Fan out one request per stream. Using allSettled means a single stream the token
// can't read (403) no longer sinks the whole call — we keep the streams that
// succeeded and report the ones that failed. Throws only when EVERY stream fails,
// so the catch/errorResult path still surfaces the hint for a total failure.
async function fanOut(streams, worker) {
  const settled = await Promise.allSettled(streams.map(worker));
  const results = [];
  const failures = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") results.push(r.value);
    else failures.push({ stream: streams[i], error: r.reason });
  });
  if (results.length === 0) throw failures[0].error;
  return { results, failures };
}

// One-line, agent-actionable warning for streams that failed in a partial fan-out.
function partialWarning(failures, totalStreams) {
  const detail = failures
    .map(
      (f) => `${f.stream}${f.error.response?.status ? ` (HTTP ${f.error.response.status})` : ""}`,
    )
    .join(", ");
  return (
    `${failures.length} of ${totalStreams} streams could not be queried and are excluded from these results: ${detail}. ` +
    `Call list_streams to confirm which streams this token can read.`
  );
}

// Build the universal-search path and time params, choosing the absolute endpoint
// when an ISO from/to window is supplied, otherwise the relative one.
// `kind` is "" (messages), "terms", or "histogram".
function buildSearch(args) {
  const sub = "";
  if (args.from && args.to) {
    return {
      makePath: (k) => `/api/search/universal/absolute${k ? `/${k}` : sub}`,
      time: { from: args.from, to: args.to },
    };
  }
  const range = args.searchTimeRangeInSeconds ?? 900;
  return {
    makePath: (k) => `/api/search/universal/relative${k ? `/${k}` : sub}`,
    time: { range },
  };
}

// High-signal fields kept in the concise projection, in output order. Only those
// actually populated on a message are emitted.
const CONCISE_FIELDS = [
  "timestamp",
  "source",
  "level",
  "container_name",
  "pod_name",
  "namespace_name",
  "application_name",
  "service",
  "logger_name",
  "message",
];
const MAX_MESSAGE_CHARS = 2000;

function projectConcise(msg, index) {
  const out = {};
  for (const f of CONCISE_FIELDS) {
    if (msg[f] !== undefined && msg[f] !== null) out[f] = msg[f];
  }
  if (typeof out.message === "string" && out.message.length > MAX_MESSAGE_CHARS) {
    out.message =
      out.message.slice(0, MAX_MESSAGE_CHARS) +
      `…[truncated ${out.message.length - MAX_MESSAGE_CHARS} chars — use get_message for the full body]`;
  }
  // Identifiers needed to drill into the full document via get_message.
  if (msg._id !== undefined) out._id = msg._id;
  if (index !== undefined) out._index = index;
  return out;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const instanceList =
  ACTIVE_LABELS.length > 0 ? ACTIVE_LABELS.map((l) => `"${l}"`).join(", ") : "(none configured)";
const instanceProp = {
  type: "string",
  enum: ACTIVE_LABELS.length > 0 ? ACTIVE_LABELS : undefined,
  description: `Graylog instance to query. Active: ${instanceList}. Default: "${DEFAULT_INSTANCE?.label ?? "none"}".`,
};
const streamsProp = {
  type: "string",
  description:
    `Comma-separated Graylog stream IDs (from list_streams). Required. ` +
    `Use "${DEFAULT_STREAM_ID}" to search everything the token can see.`,
};
const queryProp = {
  type: "string",
  description: `Lucene query, e.g. "level:ERROR", "error OR exception", "source:api-*". Use "*" for everything.`,
};
const timeRangeProp = {
  type: "number",
  description:
    "Relative time range in seconds, ending now. Default: 900 (15 min). Ignored if from/to are set.",
};
const fromProp = {
  type: "string",
  description:
    'Absolute window start, ISO-8601 UTC (e.g. "2026-07-11 14:00:00"). Requires `to`. Overrides the relative range.',
};
const toProp = {
  type: "string",
  description: "Absolute window end, ISO-8601 UTC. Requires `from`.",
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_streams",
        description:
          "List the Graylog streams the API token can read (id + title). Call this first to " +
          "get stream IDs for search/analyze; only readable streams are returned.",
        inputSchema: {
          type: "object",
          properties: {
            instance: instanceProp,
            titleContains: {
              type: "string",
              description: "Optional case-insensitive substring filter on the stream title.",
            },
          },
          required: [],
        },
      },
      {
        name: "search",
        description:
          "Search log messages across one or more streams; results merged newest-first. " +
          "Returns a concise projection of high-signal fields by default (set verbose:true for " +
          "all fields). Use this to read individual matching log lines.",
        inputSchema: {
          type: "object",
          properties: {
            instance: instanceProp,
            query: queryProp,
            streams: streamsProp,
            searchTimeRangeInSeconds: timeRangeProp,
            from: fromProp,
            to: toProp,
            searchCountLimit: {
              type: "number",
              description: "Max messages to return. Default: 50.",
            },
            verbose: {
              type: "boolean",
              description:
                "Return every populated field (untruncated) instead of the concise projection. Default: false.",
            },
            fields: {
              type: "string",
              description:
                "Comma-separated explicit field list to return. Overrides the concise projection.",
            },
          },
          required: ["query", "streams"],
        },
      },
      {
        name: "analyze",
        description:
          "Aggregate matching messages by the top values of a field (e.g. which sources, " +
          "containers, or levels dominate) instead of returning raw lines. Optionally add a " +
          "time histogram of match volume. Use this first during an incident to find patterns " +
          "cheaply before drilling in with search.",
        inputSchema: {
          type: "object",
          properties: {
            instance: instanceProp,
            field: {
              type: "string",
              description:
                'Field to break down by, e.g. "source", "container_name", "level", "status_code".',
            },
            query: {
              ...queryProp,
              description: `${queryProp.description} Default: "*".`,
            },
            streams: streamsProp,
            searchTimeRangeInSeconds: timeRangeProp,
            from: fromProp,
            to: toProp,
            size: {
              type: "number",
              description: "Number of top values to return. Default: 20.",
            },
            histogramInterval: {
              type: "string",
              enum: ["minute", "hour", "day", "week", "month"],
              description:
                "If set, also return a time histogram of total match counts at this bucket size.",
            },
          },
          required: ["field", "streams"],
        },
      },
      {
        name: "get_message",
        description:
          "Fetch the full, untruncated document for a single message by its _id and _index " +
          "(both returned by search). Use after a concise search to inspect one hit in full.",
        inputSchema: {
          type: "object",
          properties: {
            instance: instanceProp,
            messageId: {
              type: "string",
              description: "The message _id from a search result.",
            },
            index: {
              type: "string",
              description: "The message _index from a search result.",
            },
          },
          required: ["messageId", "index"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case "list_streams":
      return listStreams(request);
    case "search":
      return searchMessages(request);
    case "analyze":
      return analyzeMessages(request);
    case "get_message":
      return getMessage(request);
    default:
      throw new Error(`Tool not found: ${request.params.name}`);
  }
});

// ---------------------------------------------------------------------------
// list_streams
// ---------------------------------------------------------------------------

async function listStreams(request) {
  const args = request.params.arguments ?? {};
  const { instance, error } = resolveInstance(args);
  if (error) return error;

  try {
    const data = await graylogGet(instance, "/api/streams");

    const filter = args.titleContains?.toLowerCase();
    let streams = (data?.streams ?? []).map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      disabled: s.disabled,
    }));

    // GET /api/streams omits the built-in "All messages" default stream, but it
    // is searchable and is where messages not routed to a named stream land
    // (searching it is effectively "search everything this token can see").
    // Surface it explicitly so it is discoverable, if the token can read it.
    if (!streams.some((s) => s.id === DEFAULT_STREAM_ID)) {
      try {
        const def = await graylogGet(instance, `/api/streams/${DEFAULT_STREAM_ID}`);
        streams.unshift({
          id: def?.id ?? DEFAULT_STREAM_ID,
          title: def?.title ?? "All messages",
          description: `${def?.description ?? "Default stream"} (default — contains messages not routed to a named stream; search it to query everything)`,
          disabled: def?.disabled ?? false,
        });
      } catch {
        /* token cannot read the default stream — skip it */
      }
    }

    if (filter) {
      streams = streams.filter((s) => (s.title ?? "").toLowerCase().includes(filter));
    }
    streams.sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));

    if (process.env.DEBUG === "true") {
      console.error(
        `[graylog-mcp] instance=${instance.label} list_streams count=${streams.length}`,
      );
    }

    return jsonResult({ total: streams.length, streams });
  } catch (error) {
    return errorResult(instance, "listing streams", error);
  }
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

async function searchMessages(request) {
  const args = request.params.arguments ?? {};
  const { instance, error } = resolveInstance(args);
  if (error) return error;

  const query = args.query;
  const searchCountLimit = args.searchCountLimit ?? 50;
  const verbose = args.verbose === true;
  const explicitFields = args.fields;
  const streams = parseStreams(args.streams);

  if (streams.length === 0) {
    return textResult(
      "No streams provided. `search` requires a comma-separated list of stream IDs. " +
        "Call `list_streams` first to obtain them.",
    );
  }

  const { makePath, time } = buildSearch(args);

  // The legacy universal search returns the FULL message object (every populated
  // field) as JSON, but only accepts one stream per request. So fan out over the
  // requested streams and merge.
  try {
    const { results: perStream, failures } = await fanOut(streams, async (streamId) => {
      const params = {
        query,
        ...time,
        limit: searchCountLimit,
        filter: `streams:${streamId}`,
      };
      // When the caller asks for explicit fields, push the projection to Graylog.
      if (explicitFields) params.fields = explicitFields;
      const data = await graylogGet(instance, makePath(""), params);
      // Preserve each hit's index alongside its message so we can build _index.
      const messages = (data.messages ?? []).map((m) => ({
        msg: m.message ?? m,
        index: m.index,
      }));
      return { messages, total: data.total_results ?? 0 };
    });

    const totalMatched = perStream.reduce((n, r) => n + r.total, 0);
    const merged = perStream
      .flatMap((r) => r.messages)
      // Merge across streams, newest first, then cap to the requested limit.
      .sort((a, b) => String(b.msg.timestamp ?? "").localeCompare(String(a.msg.timestamp ?? "")))
      .slice(0, searchCountLimit);

    const messages = merged.map(({ msg, index }) =>
      verbose || explicitFields
        ? { ...msg, _index: index ?? msg._index }
        : projectConcise(msg, index),
    );

    if (process.env.DEBUG === "true") {
      console.error(
        `[graylog-mcp] instance=${instance.label} search streams=${streams.length} query=${query} matched=${totalMatched} returned=${messages.length}`,
      );
    }

    const result = {
      returned: messages.length,
      total_matched: totalMatched,
      streams,
      messages,
    };
    if (totalMatched > messages.length) {
      result.note =
        `Showing the newest ${messages.length} of ${totalMatched} matches. To see more, ` +
        `narrow the query, shorten the time range, raise searchCountLimit, or use analyze to aggregate.`;
    }
    if (!verbose && !explicitFields) {
      result.projection =
        "concise (high-signal fields only; set verbose:true or use get_message for full documents)";
    }
    if (failures.length) {
      result.failed_streams = failures.map((f) => f.stream);
      result.warning = partialWarning(failures, streams.length);
    }
    return jsonResult(result);
  } catch (error) {
    return errorResult(instance, "searching messages", error);
  }
}

// ---------------------------------------------------------------------------
// analyze — top values of a field (+ optional time histogram)
// ---------------------------------------------------------------------------

async function analyzeMessages(request) {
  const args = request.params.arguments ?? {};
  const { instance, error } = resolveInstance(args);
  if (error) return error;

  const field = args.field;
  const query = args.query ?? "*";
  const size = args.size ?? 20;
  const streams = parseStreams(args.streams);

  if (!field) {
    return textResult('`analyze` requires a `field` to break down by (e.g. "source", "level").');
  }
  if (streams.length === 0) {
    return textResult(
      "No streams provided. `analyze` requires a comma-separated list of stream IDs. " +
        "Call `list_streams` first to obtain them.",
    );
  }

  const { makePath, time } = buildSearch(args);

  try {
    // Terms aggregation: fan out per stream and sum the per-value counts.
    const { results: perStream, failures } = await fanOut(streams, async (streamId) => {
      const params = {
        field,
        query,
        ...time,
        size,
        filter: `streams:${streamId}`,
      };
      return await graylogGet(instance, makePath("terms"), params);
    });

    const counts = {};
    let missing = 0;
    let other = 0;
    for (const data of perStream) {
      for (const [value, count] of Object.entries(data.terms ?? {})) {
        counts[value] = (counts[value] ?? 0) + count;
      }
      missing += data.missing ?? 0;
      other += data.other ?? 0;
    }

    const top = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, size)
      .map(([value, count]) => ({ value, count }));

    const result = {
      field,
      query,
      streams,
      top_values: top,
      missing, // messages in range with no value for this field
      other, // matches beyond the returned top-N values
    };
    if (failures.length) {
      result.failed_streams = failures.map((f) => f.stream);
      result.warning = partialWarning(failures, streams.length);
    }

    // Optional time histogram of total match volume (no field breakdown).
    // Best-effort per stream: the terms result above already reported which
    // streams the token can't read, so we just merge whatever histograms succeed.
    if (args.histogramInterval) {
      const settledHist = await Promise.allSettled(
        streams.map(async (streamId) => {
          const params = {
            query,
            ...time,
            interval: args.histogramInterval,
            filter: `streams:${streamId}`,
          };
          const data = await graylogGet(instance, makePath("histogram"), params);
          return data?.results ?? {};
        }),
      );
      const buckets = {};
      for (const r of settledHist) {
        if (r.status !== "fulfilled") continue;
        for (const [ts, count] of Object.entries(r.value)) {
          buckets[ts] = (buckets[ts] ?? 0) + count;
        }
      }
      result.histogram = {
        interval: args.histogramInterval,
        buckets: Object.entries(buckets)
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([ts, count]) => ({
            time: new Date(Number(ts) * 1000).toISOString(),
            count,
          })),
      };
    }

    if (process.env.DEBUG === "true") {
      console.error(
        `[graylog-mcp] instance=${instance.label} analyze field=${field} streams=${streams.length} values=${top.length}`,
      );
    }

    return jsonResult(result);
  } catch (error) {
    return errorResult(instance, "analyzing messages", error);
  }
}

// ---------------------------------------------------------------------------
// get_message — full document for a single hit
// ---------------------------------------------------------------------------

async function getMessage(request) {
  const args = request.params.arguments ?? {};
  const { instance, error } = resolveInstance(args);
  if (error) return error;

  const messageId = args.messageId;
  const index = args.index;
  if (!messageId || !index) {
    return textResult(
      "`get_message` requires both `messageId` and `index` (both come from a search result's _id and _index).",
    );
  }

  try {
    const data = await graylogGet(
      instance,
      `/api/messages/${encodeURIComponent(index)}/${encodeURIComponent(messageId)}`,
    );
    // Graylog returns { index, message: { ...fields } }.
    const message = data?.message ?? data;
    return jsonResult({ index, message });
  } catch (error) {
    return errorResult(instance, `fetching message ${messageId}`, error);
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
