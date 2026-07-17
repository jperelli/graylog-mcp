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

Start here: pass \`streams:"*"\` to search EVERY stream the token can read. Do not
treat the Default Stream ("${DEFAULT_STREAM_ID}") as "everything": most clusters
route each service to its own stream that is set to REMOVE its matches from the
Default Stream, so that stream can be missing entire services' logs. If you know
the specific stream you want, scope to it (find it with \`list_streams\`
\`titleContains\`); when in doubt, "*" is the safe default.

Do not guess field names or values — the wrong guess looks exactly like "no
logs exist". Discover them first:
- \`list_fields\` (with \`contains\`) → which fields are actually indexed.
- \`analyze\` with \`valueContains\` → which values a field actually has, e.g.
  the real namespace/pod/service name. This is the ONLY way to substring-match a
  value: Elasticsearch rejects a leading wildcard, so \`field:*foo*\` is an error.

Then \`search\` for raw lines, and \`get_message\` for one hit's full document.

Prefer \`analyze\` over \`search\` to find out WHAT is happening. Aggregating by a
message field (\`analyze\` on \`msg\`, or on whatever short summary field
\`list_fields\` shows) collapses a thousand repetitions of one error into one row
with a count. Reading the same thing as raw lines costs hundreds of times more
context and tells you less. Use \`search\` once you know which line you want.

Key constraints and quirks:
- \`streams\` is mandatory for search/analyze: pass "*" for all readable streams,
  or a comma-separated list of ids. There is no implicit all-streams search (a
  limited-permission token is 403'd on an unscoped query), so "*" is expanded to
  the concrete list of streams the token can actually read. If a search over only
  the Default Stream returns nothing for a service you know exists, its stream
  almost certainly removes itself from the Default Stream — retry with "*".
- Query syntax is Graylog/Elasticsearch Lucene: e.g. \`level:ERROR\`,
  \`source:api-*\`, \`error OR exception\`. A quoted string before ':' is a hard
  error, not an empty result (\`"level":50\` — drop the quotes: \`level:50\`).
- WILDCARDS: \`*\` on its own means "everything" (a fine query). A wildcard is
  also fine in the MIDDLE or at the END of a term — \`source:api-*\`, \`pod:*-abc\`,
  \`na*me\` all work. But a wildcard at the START of a term is a HARD ERROR, never
  an empty result: \`*foo\`, \`field:*foo*\`, \`pod_name:*event-validation*\`.
  Elasticsearch refuses to open a term with \`*\` or \`?\` because it can't use the
  index. Newer Graylog reports this clearly ("not allowed as first character in
  WildcardQuery"); OLDER Graylog (e.g. 4.2) just returns an opaque HTTP 500
  "Unable to perform search query" — same cause, so don't read that 500 as an
  outage. To match a value you only know the middle of (the usual reason you'd
  reach for a leading wildcard), don't wildcard it: use \`analyze\` with
  \`valueContains\`, which scans the value buckets and filters them locally.
- SEVERITY IS NOT UNIFORM, AND MUST BE DISCOVERED — do not guess a spelling.
  Some services emit a top-level Graylog \`level\` (syslog: 3=error, 4=warn).
  Others log JSON, and the shipper extracts its keys into their OWN fields:
  pino's \`{"level":50,"msg":"Error","name":"SvcX"}\` typically becomes fields
  \`msg\` and \`name\`, while its numeric \`level\` is LOST — it collides with the
  container's own \`level\` (often 7), so \`level:50\` and \`level:ERROR\` both match
  NOTHING even though errors are plainly there. Find the real handle instead of
  guessing a disjunction: run \`list_fields\` (contains "level", "msg", "err"),
  then \`analyze\` on \`msg\` to see the actual severity/message values. Free-text
  (\`error\`) works as a fallback, but do not assume \`exception\` or \`fatal\` are
  present — on many deployments they match nothing.
- A log line is only searchable once Graylog has INDEXED it, which can lag
  ingestion by hours when the pipeline is backed up. In that state a correct
  query over a recent window truthfully returns 0 matches. \`search\` detects
  this and reports the indexing lag alongside an empty result — read that note
  before concluding the logs do not exist, and widen the time range.
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

// Authenticated POST with a JSON body. Same auth/CSRF rules as graylogGet; the
// Views search API (see viewsSearch) is POST-only.
async function graylogPost(instance, path, body) {
  const auth = Buffer.from(`${instance.apiToken}:token`).toString("base64");
  let resp;
  try {
    resp = await fetch(new URL(instance.baseUrl + path), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Requested-By": "graylog-mcp",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    if (cause?.name === "TimeoutError") {
      throw new Error(`Request to ${instance.label} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw cause;
  }

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

// Run one Views/Aggregations search and return its search_types results.
//
// This replaces the legacy /api/search/universal/{relative,absolute}/{terms,histogram}
// endpoints, which Graylog 6.0 REMOVED (they 404 there while the plain search
// endpoint still answers). Unlike the legacy API this accepts every stream in a
// single request, so there is no fan-out to merge.
//
// Careful: a query that fails inside Elasticsearch still comes back HTTP 200,
// with `completed_exceptionally` set and the reason in `errors`. Surface that as
// an error instead of silently reporting zero results.
async function viewsSearch(instance, { query, streams, timerange, searchTypes }) {
  const body = {
    queries: [
      {
        id: "q",
        query: { type: "elasticsearch", query_string: query },
        timerange,
        filter: { type: "or", filters: streams.map((id) => ({ type: "stream", id })) },
        search_types: searchTypes,
      },
    ],
  };

  const data = await graylogPost(instance, "/api/views/search/sync", body);
  const result = data?.results?.q;
  const errors = result?.errors ?? [];

  if (errors.length > 0) {
    const err = new Error(errors.map((e) => e.description ?? String(e)).join("; "));
    err.response = { status: 200, data: { errors } };
    throw err;
  }
  return result?.search_types ?? {};
}

// Run a Views search, dropping any stream the token cannot read rather than
// failing outright. The Views API takes every stream in one request, so a single
// unreadable stream would 403 the whole call — but the 403 body names the
// offending streams (MissingStreamPermission), so we can drop them and retry once
// and still answer from the readable ones. Costs one extra request, only on 403.
async function viewsSearchTolerant(instance, params) {
  try {
    const results = await viewsSearch(instance, params);
    return { results, streams: params.streams, denied: [] };
  } catch (error) {
    const denied = error.response?.status === 403 ? (error.response.data?.streams ?? []) : [];
    const readable = params.streams.filter((s) => !denied.includes(s));
    // Nothing identifiable to drop, or nothing left to search: a real failure.
    if (denied.length === 0 || readable.length === 0) throw error;

    const results = await viewsSearch(instance, { ...params, streams: readable });
    return { results, streams: readable, denied };
  }
}

// Pull (value, count) pairs out of a pivot result. Graylog returns one "leaf" row
// per bucket — key[0] is the bucket, values[0].value the count — plus a trailing
// "non-leaf" rollup row with an empty key holding the grand total.
function pivotRows(searchType) {
  const rows = searchType?.rows ?? [];
  return rows
    .filter((r) => Array.isArray(r.key) && r.key.length > 0)
    .map((r) => ({ value: r.key[0], count: r.values?.[0]?.value ?? 0 }));
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
  if (/not allowed as first character/i.test(error.message)) {
    hint =
      "\nHint: Elasticsearch rejects a leading wildcard, so `field:*foo*` can never work. " +
      "To find a value you only half-know, use analyze with `valueContains` instead.";
  } else if (status === 403) {
    hint =
      "\nHint: the token likely lacks read access to one of the requested streams. " +
      "Call list_streams to see which streams this token can read, and search only those.";
  } else if (status === 400) {
    hint =
      "\nHint: the query may be invalid Lucene. Avoid a quoted string before ':' " +
      '(e.g. "level":50); try `error OR exception` or `*` to confirm connectivity.';
  } else if (status === 404) {
    hint =
      "\nHint: this Graylog does not expose that endpoint. The legacy universal-search " +
      "terms/histogram sub-resources were removed in Graylog 6.0; aggregation now goes " +
      "through the Views API.";
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

// Fetch every stream id the token can read, plus the built-in Default Stream.
// Cached briefly: "*" may be used repeatedly in one session and stream membership
// changes rarely. This is what lets streams:"*" reach services whose streams
// REMOVE their matches from the Default Stream — searching that stream alone
// silently misses them, which is the single most misleading failure on a cluster
// that uses per-service streams (a real prod cluster had 360 of 361 streams set
// to remove-from-default).
const ALL_STREAMS_TTL_MS = 300000;
const allStreamsCache = new Map();

async function readableStreamIds(instance) {
  const cached = allStreamsCache.get(instance.label);
  if (cached && Date.now() - cached.ts < ALL_STREAMS_TTL_MS) return cached.ids;
  const data = await graylogGet(instance, "/api/streams");
  const ids = (data?.streams ?? []).map((s) => s.id).filter(Boolean);
  // GET /api/streams omits the Default Stream, but unrouted messages (and the
  // matches of streams that do NOT remove themselves) live there, so include it.
  if (!ids.includes(DEFAULT_STREAM_ID)) ids.unshift(DEFAULT_STREAM_ID);
  allStreamsCache.set(instance.label, { ids, ts: Date.now() });
  return ids;
}

// Expand a raw `streams` arg into concrete ids. "*" (alone or among a list) means
// "every readable stream". Returns { ids, wildcard }.
async function resolveStreamIds(instance, raw) {
  const parsed = parseStreams(raw);
  if (parsed.includes("*")) {
    return { ids: await readableStreamIds(instance), wildcard: true };
  }
  return { ids: parsed, wildcard: false };
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

// One-line, agent-actionable warning for streams that had to be excluded. Takes
// [{ stream, status? }] so both the fan-out (search) and the retry-without-denied
// path (analyze) can report the same way.
function partialWarning(excluded, totalStreams) {
  const detail = excluded
    .map((e) => `${e.stream}${e.status ? ` (HTTP ${e.status})` : ""}`)
    .join(", ");
  return (
    `${excluded.length} of ${totalStreams} streams could not be queried and are excluded from these results: ${detail}. ` +
    `The results below cover the remaining readable streams. ` +
    `Call list_streams to confirm which streams this token can read.`
  );
}

const DEFAULT_RANGE_SECONDS = 900;

// Build the universal-search path and time params, choosing the absolute endpoint
// when an ISO from/to window is supplied, otherwise the relative one.
//
// Only the plain message endpoint is reachable this way: Graylog 6.0 removed the
// /terms and /histogram sub-resources, so aggregation goes through viewsSearch.
function buildSearch(args) {
  if (args.from && args.to) {
    return {
      path: "/api/search/universal/absolute",
      time: { from: args.from, to: args.to },
    };
  }
  return {
    path: "/api/search/universal/relative",
    time: { range: args.searchTimeRangeInSeconds ?? DEFAULT_RANGE_SECONDS },
  };
}

// The Views API is stricter than the legacy one: it wants real ISO-8601, so
// accept the "2026-07-12 00:00:00" form the legacy endpoint tolerates and lift it.
function toIso(value) {
  const parsed = new Date(String(value).includes("T") ? value : String(value).replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `Invalid timestamp "${value}" — use ISO-8601 UTC, e.g. "2026-07-12T14:00:00Z".`,
    );
  }
  return parsed.toISOString();
}

// Same window as buildSearch, in the shape the Views API expects.
function viewsTimeRange(args) {
  if (args.from && args.to) {
    return { type: "absolute", from: toIso(args.from), to: toIso(args.to) };
  }
  return { type: "relative", range: args.searchTimeRangeInSeconds ?? DEFAULT_RANGE_SECONDS };
}

// Graylog's legacy histogram took a bare unit name; the Views API takes a timeunit.
const HISTOGRAM_TIMEUNITS = {
  minute: "1m",
  hour: "1h",
  day: "1d",
  week: "1w",
  month: "1M",
};

// High-signal fields kept in the concise projection, in output order. Only those
// actually populated on a message are emitted.
//
// `msg`, `name`, `err` and `stack` matter as much as the k8s ones: a shipper that
// parses a JSON log line (pino, bunyan, structlog) extracts its keys into real
// fields, so these carry the summary of the event. Without them the projection
// falls back to the raw `message` — the whole JSON blob that *contains* them —
// which is how a 50-hit search used to cost ~37k tokens.
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
  "name",
  "msg",
  "err",
  "stack",
  "message",
];

// The raw body is mostly redundant with the fields above once a JSON line has been
// parsed, so keep only enough to recognise it. `messageChars` raises this, and
// get_message returns the document whole.
const DEFAULT_MESSAGE_CHARS = 500;

function projectConcise(msg, index, maxMessageChars = DEFAULT_MESSAGE_CHARS) {
  const out = {};
  for (const f of CONCISE_FIELDS) {
    if (msg[f] !== undefined && msg[f] !== null) out[f] = msg[f];
  }
  if (typeof out.message === "string" && out.message.length > maxMessageChars) {
    out.message =
      out.message.slice(0, maxMessageChars) +
      `…[truncated ${out.message.length - maxMessageChars} chars — raise messageChars, or use get_message for the full body]`;
  }
  // Identifiers needed to drill into the full document via get_message.
  if (msg._id !== undefined) out._id = msg._id;
  if (index !== undefined) out._index = index;
  return out;
}

// Project a message down to an explicit field list, client-side. The legacy
// per-stream search pushes `fields` to Graylog, but the Views `messages` type used
// by the streams:"*" path returns the whole document, so it is filtered here.
function projectExplicit(msg, index, fieldList) {
  const out = {};
  for (const f of fieldList) {
    if (msg[f] !== undefined && msg[f] !== null) out[f] = msg[f];
  }
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
    `Comma-separated Graylog stream IDs (from list_streams), or "*" for every ` +
    `stream the token can read. Required. Prefer "*" unless you already know the ` +
    `stream: the Default Stream ("${DEFAULT_STREAM_ID}") is NOT "everything" — most ` +
    `clusters route each service to its own stream that REMOVES its matches from the ` +
    `Default Stream, so searching only the Default Stream silently misses those services.`,
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
          "List the Graylog streams the API token can read (id + title, and whether each removes " +
          'its matches from the Default Stream). To search everything, pass streams:"*" to ' +
          "search/analyze rather than listing streams here. A cluster can hold thousands of " +
          "streams, so results are capped — use `titleContains` to find one specific named stream " +
          "(e.g. a service whose logs are absent from the Default Stream).",
        inputSchema: {
          type: "object",
          properties: {
            instance: instanceProp,
            titleContains: {
              type: "string",
              description: "Case-insensitive substring filter on the stream title.",
            },
            limit: {
              type: "number",
              description: "Max streams to return. Default: 50.",
            },
          },
          required: [],
        },
      },
      {
        name: "list_fields",
        description:
          "List the message fields that actually exist in the index. Use this BEFORE searching " +
          "on a field you have not seen in a result, so you never guess a field name — a query " +
          "on a nonexistent field returns 0 matches, which is indistinguishable from 'no logs'. " +
          'Clusters index thousands of fields, so pass `contains` to narrow (e.g. "namespace").',
        inputSchema: {
          type: "object",
          properties: {
            instance: instanceProp,
            contains: {
              type: "string",
              description:
                'Case-insensitive substring filter on the field name, e.g. "namespace", "pod", "level".',
            },
            limit: {
              type: "number",
              description: "Max field names to return. Default: 100.",
            },
          },
          required: [],
        },
      },
      {
        name: "search",
        description:
          "Read individual matching log lines across one or more streams, merged newest-first. " +
          "Returns a concise projection of high-signal fields by default (set verbose:true for " +
          "all fields). Raw lines are expensive: if you want to know WHAT is failing rather than " +
          "read specific lines, use analyze first — a hundred repetitions of one error cost a " +
          'hundred times as much here as one aggregated count. Pass streams:"*" to cover every ' +
          "readable stream when you do not know which stream a service logs to (the Default " +
          "Stream often excludes it).",
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
            messageChars: {
              type: "number",
              description:
                `Max characters of the raw message body per hit. Default: ${DEFAULT_MESSAGE_CHARS}. ` +
                "The parsed fields (msg, name, err) usually carry the summary already, so raise " +
                "this only when the detail you need lives in the raw body.",
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
          "Aggregate matching messages by the top values of a field instead of returning raw " +
          "lines. Optionally add a time histogram of match volume. Three main uses: " +
          "(1) WHAT IS FAILING — aggregate on a message field (`msg`, or whatever short summary " +
          "field list_fields reveals) to collapse a thousand repetitions of one error into one " +
          "row with a count; on `name`/`container_name`/`source` to see who is emitting them. " +
          "This is far cheaper and more informative than reading the same lines via search. " +
          "(2) WHEN — set histogramInterval to see whether volume spiked. " +
          "(3) DISCOVER A VALUE you are about to filter on — set `valueContains` to find the " +
          "real name of a namespace/pod/service rather than guessing it (Elasticsearch rejects " +
          "a leading wildcard, so `field:*foo*` is an error and this is the only way to " +
          'substring-match a value). Pass streams:"*" to aggregate across every readable ' +
          "stream in one request — cheap here, and the reliable way to see a service whose " +
          "stream removes its matches from the Default Stream.",
        inputSchema: {
          type: "object",
          properties: {
            instance: instanceProp,
            field: {
              type: "string",
              description:
                'Field to break down by, e.g. "source", "namespace_name", "container_name", "level". ' +
                "Confirm it exists with list_fields if you have not seen it in a result.",
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
            valueContains: {
              type: "string",
              description:
                "Case-insensitive substring filter on the returned VALUES, applied locally over a " +
                'wide bucket scan. Use to find a value you only half-know, e.g. field:"namespace_name" ' +
                'valueContains:"catalogue" to learn the exact namespace before filtering on it.',
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
    case "list_fields":
      return listFields(request);
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
    const limit = args.limit ?? 50;
    let streams = (data?.streams ?? []).map((s) => ({
      id: s.id,
      title: s.title,
      disabled: s.disabled,
      // Surface this: a stream with the flag pulls its matches OUT of the Default
      // Stream, so those logs are invisible to a Default-Stream-only search.
      ...(s.remove_matches_from_default_stream ? { removes_from_default_stream: true } : {}),
    }));

    // How many streams hide their matches from the Default Stream. When it is most
    // of them, "search the Default Stream" is actively misleading — the agent must
    // use streams:"*" (or a specific stream) to see those services at all.
    const removedFromDefault = (data?.streams ?? []).filter(
      (s) => s.remove_matches_from_default_stream,
    ).length;

    // GET /api/streams omits the built-in "All messages" default stream, but it
    // is searchable and is where messages not routed to a named stream land
    // (searching it is effectively "search everything this token can see").
    // Surface it explicitly so it is discoverable, if the token can read it.
    let defaultStream = null;
    if (!streams.some((s) => s.id === DEFAULT_STREAM_ID)) {
      try {
        const def = await graylogGet(instance, `/api/streams/${DEFAULT_STREAM_ID}`);
        defaultStream = {
          id: def?.id ?? DEFAULT_STREAM_ID,
          title: def?.title ?? "All messages",
          disabled: def?.disabled ?? false,
        };
      } catch {
        /* token cannot read the default stream — skip it */
      }
    }

    const totalReadable = streams.length + (defaultStream ? 1 : 0);

    if (filter) {
      streams = streams.filter((s) => (s.title ?? "").toLowerCase().includes(filter));
    }
    streams.sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));

    const matched = streams.length;
    streams = streams.slice(0, limit);
    // Keep the default stream pinned to the top and outside the cap: it is the one
    // stream the caller almost always wants, and it must not be truncated away.
    if (defaultStream && !filter) streams.unshift(defaultStream);

    if (process.env.DEBUG === "true") {
      console.error(
        `[graylog-mcp] instance=${instance.label} list_streams total=${totalReadable} returned=${streams.length}`,
      );
    }

    const result = {
      total_readable: totalReadable,
      matched,
      returned: streams.length,
      default_stream_id: DEFAULT_STREAM_ID,
      streams,
    };
    if (filter) result.title_contains = args.titleContains;
    if (removedFromDefault > 0) {
      result.streams_removing_from_default = removedFromDefault;
      result.default_stream_note =
        `${removedFromDefault} of ${totalReadable} readable streams REMOVE their matches from ` +
        `the Default Stream ("${DEFAULT_STREAM_ID}"), so a search scoped only to it silently ` +
        `misses those services. Use streams:"*" to search all readable streams, or scope to a ` +
        `specific stream id.`;
    }
    if (matched > streams.length || (!filter && totalReadable > limit)) {
      result.note =
        `${matched} of ${totalReadable} readable streams matched; showing ${streams.length}. ` +
        `Narrow with \`titleContains\`, raise \`limit\`, or search across every readable stream ` +
        `at once with streams:"*" (the Default Stream "${DEFAULT_STREAM_ID}" does NOT necessarily ` +
        `cover them — many streams remove their matches from it).`;
    }
    if (filter && matched === 0) {
      result.why_no_results =
        `No stream title contains "${args.titleContains}". Search with streams:"*" instead — it ` +
        `covers every stream this token can read (the Default Stream "${DEFAULT_STREAM_ID}" alone ` +
        `may exclude services that remove their matches from it) — and filter by a field such as ` +
        `namespace_name or source.`;
    }
    return jsonResult(result);
  } catch (error) {
    return errorResult(instance, "listing streams", error);
  }
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

// Work out WHY a search matched nothing, so an empty result is actionable instead
// of ambiguous. Three causes look identical from a bare `total_matched: 0`:
//   1. the query is wrong (bad field name or value) — but the window has data;
//   2. the window is genuinely empty for these streams;
//   3. the logs exist but Graylog has not INDEXED them yet, because message
//      processing is lagging behind ingestion (this can run to hours), in which
//      case a correct query over a recent window honestly returns nothing.
// Distinguishing (3) matters most: the logs are there, just not searchable yet.
// Only runs on a zero-match search, and only makes cheap capped probes.
async function diagnoseEmpty(instance, { streams, time, path }) {
  const probe = async (params) => {
    const { results } = await fanOut(streams, (streamId) =>
      graylogGet(instance, params.path ?? path, {
        query: "*",
        ...(params.time ?? time),
        limit: 1,
        filter: `streams:${streamId}`,
      }),
    );
    const total = results.reduce((n, r) => n + (r.total_results ?? 0), 0);
    const newest = results
      .flatMap((r) => r.messages ?? [])
      .map((m) => m.message ?? m)
      .sort((a, b) => String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")))[0];
    return { total, newest };
  };

  try {
    // Does the requested window hold ANY message for these streams?
    const inWindow = await probe({});
    if (inWindow.total > 0) {
      let why =
        `The query matched 0 of the ${inWindow.total} messages in this window, so the streams and ` +
        `time range are fine — the query itself is almost certainly wrong. Verify the field exists ` +
        `with list_fields, and that the value exists with analyze (valueContains), before assuming ` +
        `these logs do not exist.`;
      // Searching ONLY the Default Stream is the classic trap: a service routed to
      // its own stream that removes its matches from the Default Stream is entirely
      // absent here even though it is present in Graylog. Point at streams:"*".
      if (streams.length === 1 && streams[0] === DEFAULT_STREAM_ID) {
        why +=
          ` NOTE: you searched ONLY the Default Stream. Many clusters route each service to a ` +
          `dedicated stream configured to REMOVE its matches from the Default Stream, so a whole ` +
          `service's logs can be missing here while present in Graylog. If you expected a specific ` +
          `service, retry with streams:"*" (all readable streams), or find its stream with ` +
          `list_streams (titleContains).`;
      }
      return why;
    }

    // The window is empty. Look further back for the newest message Graylog has
    // actually indexed: if that is well in the past, indexing is behind and recent
    // logs are simply not searchable yet.
    const recent = await probe({
      path: "/api/search/universal/relative",
      time: { range: 86400 },
    });

    if (!recent.newest) {
      return (
        `These streams hold no indexed messages in the last 24h at all. Check the stream ids ` +
        `(list_streams) — or the token may not be able to read them.`
      );
    }

    const newestTs = new Date(recent.newest.timestamp);
    const lagSeconds = Math.round((Date.now() - newestTs.getTime()) / 1000);
    const lagText =
      lagSeconds > 3600
        ? `${(lagSeconds / 3600).toFixed(1)}h`
        : `${Math.max(0, Math.round(lagSeconds / 60))}m`;

    let note =
      `This window contains no indexed messages at all. The newest message Graylog has indexed ` +
      `for these streams is ${recent.newest.timestamp} (${lagText} old).`;

    // Anything beyond a few minutes stale points at a processing backlog rather
    // than a genuinely quiet service.
    if (lagSeconds > 600) {
      note +=
        ` That is well in the past, so Graylog is very likely still INDEXING: the logs probably ` +
        `exist but are not searchable yet. Do not conclude they are missing — either search an ` +
        `older window that ends before ${recent.newest.timestamp}, or retry later.`;
      try {
        const journal = await graylogGet(instance, "/api/system/journal");
        const backlog = journal?.uncommitted_journal_entries;
        if (typeof backlog === "number") {
          note +=
            ` Journal backlog: ${backlog.toLocaleString()} uncommitted entries ` +
            `(append ${journal.append_events_per_second ?? "?"}/s vs read ` +
            `${journal.read_events_per_second ?? "?"}/s).`;
        }
      } catch {
        /* journal needs extra permissions — the timestamp above is enough */
      }
    } else {
      note += ` Indexing looks current, so these streams are simply quiet in this window.`;
    }
    return note;
  } catch {
    // Diagnosis is best-effort: never turn a successful empty search into an error.
    return null;
  }
}

async function searchMessages(request) {
  const args = request.params.arguments ?? {};
  const { instance, error } = resolveInstance(args);
  if (error) return error;

  const query = args.query;
  const searchCountLimit = args.searchCountLimit ?? 50;
  const verbose = args.verbose === true;
  const explicitFields = args.fields;

  let streams, wildcard;
  try {
    ({ ids: streams, wildcard } = await resolveStreamIds(instance, args.streams));
  } catch (error) {
    return errorResult(instance, "expanding streams to search", error);
  }

  if (streams.length === 0) {
    return textResult(
      'No streams provided. `search` requires a comma-separated list of stream IDs, or "*" ' +
        "for every readable stream. Call `list_streams` first to obtain specific ids.",
    );
  }

  // streams:"*" fans out to every readable stream. The legacy per-stream endpoint
  // would mean hundreds of HTTP requests, so cover them all in one Views request.
  if (wildcard) return searchAllStreams(instance, args, streams);

  const { path, time } = buildSearch(args);

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
      const data = await graylogGet(instance, path, params);
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
        : projectConcise(msg, index, args.messageChars ?? DEFAULT_MESSAGE_CHARS),
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
    if (totalMatched === 0) {
      // An empty result is the single biggest source of wasted follow-up queries:
      // say which of "wrong query" / "quiet window" / "not indexed yet" it is.
      const why = await diagnoseEmpty(instance, { streams, time, path });
      if (why) result.why_no_results = why;
    } else if (totalMatched > messages.length) {
      result.note =
        `Showing the newest ${messages.length} of ${totalMatched} matches. To see more, ` +
        `narrow the query, shorten the time range, raise searchCountLimit, or use analyze to aggregate.`;
    }
    if (!verbose && !explicitFields) {
      result.projection =
        "concise (high-signal fields only, raw message body truncated; raise messageChars, " +
        "set verbose:true, or use get_message for full documents)";
    }
    if (failures.length) {
      result.failed_streams = failures.map((f) => f.stream);
      result.warning = partialWarning(
        failures.map((f) => ({ stream: f.stream, status: f.error.response?.status })),
        streams.length,
      );
    }
    return jsonResult(result);
  } catch (error) {
    return errorResult(instance, "searching messages", error);
  }
}

// search across EVERY readable stream in a single request. The legacy per-stream
// endpoint would need one HTTP call per stream (hundreds on a real cluster), so
// this uses the Views API `messages` search type, which — like analyze's pivot —
// takes all streams in one filter. A `total` pivot rides along to report
// total_matched (the messages type does not carry a total). Works on Graylog 4.2
// and 6.x alike. Any stream the token cannot read is dropped and reported, not
// fatal (viewsSearchTolerant).
async function searchAllStreams(instance, args, streams) {
  const query = args.query;
  const searchCountLimit = args.searchCountLimit ?? 50;
  const verbose = args.verbose === true;
  const explicitFields = args.fields ? parseStreams(args.fields) : null;

  const searchTypes = [
    { id: "msgs", type: "messages", limit: searchCountLimit },
    {
      id: "total",
      type: "pivot",
      rollup: true,
      row_groups: [],
      series: [{ id: "count", type: "count" }],
    },
  ];

  try {
    const {
      results,
      streams: searched,
      denied,
    } = await viewsSearchTolerant(instance, {
      query,
      streams,
      timerange: viewsTimeRange(args),
      searchTypes,
    });

    const rawMessages = results.msgs?.messages ?? [];
    const totalMatched = results.total?.total ?? 0;

    const merged = rawMessages
      .map((m) => ({ msg: m.message ?? m, index: m.index }))
      .sort((a, b) => String(b.msg.timestamp ?? "").localeCompare(String(a.msg.timestamp ?? "")))
      .slice(0, searchCountLimit);

    const messages = merged.map(({ msg, index }) =>
      verbose
        ? { ...msg, _index: index ?? msg._index }
        : explicitFields
          ? projectExplicit(msg, index, explicitFields)
          : projectConcise(msg, index, args.messageChars ?? DEFAULT_MESSAGE_CHARS),
    );

    if (process.env.DEBUG === "true") {
      console.error(
        `[graylog-mcp] instance=${instance.label} search streams=* (${searched.length}) query=${query} matched=${totalMatched} returned=${messages.length}`,
      );
    }

    const result = {
      returned: messages.length,
      total_matched: totalMatched,
      streams: `* (${searched.length} readable streams)`,
      messages,
    };
    if (totalMatched === 0) {
      result.why_no_results =
        `No message matched this query across all ${searched.length} readable streams in this ` +
        `window — the scope is already as wide as it can be, so the query itself is the likely ` +
        `cause. Confirm the field with list_fields and the value with analyze (valueContains), ` +
        `and widen the time range (indexing can lag ingestion by hours).`;
    } else if (totalMatched > messages.length) {
      result.note =
        `Showing the newest ${messages.length} of ${totalMatched} matches across all readable ` +
        `streams. Narrow the query, shorten the time range, raise searchCountLimit, or scope to ` +
        `one stream (list_streams).`;
    }
    if (!verbose && !explicitFields) {
      result.projection =
        "concise (high-signal fields only, raw message body truncated; raise messageChars, " +
        "set verbose:true, or use get_message for full documents)";
    }
    if (denied.length) {
      result.failed_streams = denied;
      result.warning = partialWarning(
        denied.map((stream) => ({ stream, status: 403 })),
        streams.length,
      );
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

  if (!field) {
    return textResult('`analyze` requires a `field` to break down by (e.g. "source", "level").');
  }

  let streams, wildcard;
  try {
    ({ ids: streams, wildcard } = await resolveStreamIds(instance, args.streams));
  } catch (error) {
    return errorResult(instance, "expanding streams to analyze", error);
  }
  if (streams.length === 0) {
    return textResult(
      'No streams provided. `analyze` requires a comma-separated list of stream IDs, or "*" ' +
        "for every readable stream. Call `list_streams` first to obtain specific ids.",
    );
  }

  const valueContains = args.valueContains?.toLowerCase();

  // A substring filter has to be applied here rather than pushed into the query,
  // because Elasticsearch rejects the leading wildcard `field:*foo*` outright. So
  // ask for a wide bucket list and narrow it locally.
  const fetchSize = valueContains ? Math.max(size, 1000) : size;

  // Use the SINGULAR `field` on each row_group, not the array `fields`. Graylog
  // 6.x accepts both, but 4.2 knows only `field` and 400s on `fields` with
  // "Unable to map property fields. Known properties include: field, limit, type".
  // Singular is the one form both versions accept, so analyze works on either
  // without probing the server version.
  const searchTypes = [
    {
      id: "terms",
      type: "pivot",
      rollup: true,
      row_groups: [{ type: "values", field, limit: fetchSize }],
      series: [{ id: "count", type: "count" }],
    },
  ];

  if (args.histogramInterval) {
    searchTypes.push({
      id: "histogram",
      type: "pivot",
      rollup: true,
      row_groups: [
        {
          type: "time",
          field: "timestamp",
          interval: {
            type: "timeunit",
            timeunit: HISTOGRAM_TIMEUNITS[args.histogramInterval],
          },
        },
      ],
      series: [{ id: "count", type: "count" }],
    });
  }

  try {
    // One request covers every stream — the Views API takes them all in its filter.
    // Any stream the token cannot read is dropped and reported, not fatal.
    const {
      results: searchTypeResults,
      streams: searched,
      denied,
    } = await viewsSearchTolerant(instance, {
      query,
      streams,
      timerange: viewsTimeRange(args),
      searchTypes,
    });

    const termsResult = searchTypeResults.terms;
    let values = pivotRows(termsResult);
    const matchedTotal = termsResult?.total ?? 0;

    const result = {
      field,
      query,
      // A wildcard expands to every readable stream (often hundreds), so summarise
      // rather than dumping the whole id list into the response.
      streams: wildcard ? `* (${searched.length} readable streams)` : searched,
      total_matched: matchedTotal,
    };
    if (denied.length) {
      result.failed_streams = denied;
      result.warning = partialWarning(
        denied.map((stream) => ({ stream, status: 403 })),
        streams.length,
      );
    }

    if (valueContains) {
      const scanned = values.length;
      values = values.filter((v) => String(v.value).toLowerCase().includes(valueContains));
      result.value_contains = args.valueContains;
      result.note =
        `Substring-filtered locally over the ${scanned} most common values of "${field}" ` +
        `(Elasticsearch cannot match a leading wildcard). A value rarer than those ${scanned} ` +
        `will not appear — narrow the query or shorten the time range if you expect one.`;
    }

    const top = values.sort((a, b) => b.count - a.count).slice(0, size);
    result.top_values = top;

    // Whatever the top values don't account for: messages with no value for this
    // field, plus any bucket past the cut-off.
    const covered = top.reduce((n, v) => n + v.count, 0);
    result.not_in_top_values = Math.max(0, matchedTotal - covered);

    if (args.histogramInterval) {
      result.histogram = {
        interval: args.histogramInterval,
        buckets: pivotRows(searchTypeResults.histogram).map((b) => ({
          time: b.value,
          count: b.count,
        })),
      };
    }

    if (top.length === 0) {
      result.why_no_results =
        matchedTotal > 0
          ? `${matchedTotal} messages matched the query, but none carry a value for "${field}" ` +
            `(or none matched valueContains). Confirm the field name with list_fields.`
          : `The query matched no messages at all in this window. Widen the time range, or run ` +
            `search with the same query — it will report whether indexing is lagging.`;
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
// list_fields — which fields actually exist
// ---------------------------------------------------------------------------

async function listFields(request) {
  const args = request.params.arguments ?? {};
  const { instance, error } = resolveInstance(args);
  if (error) return error;

  const contains = args.contains?.toLowerCase();
  const limit = args.limit ?? 100;

  try {
    const data = await graylogGet(instance, "/api/system/fields");
    const all = data?.fields ?? [];
    const matched = contains ? all.filter((f) => f.toLowerCase().includes(contains)) : all;
    const fields = [...matched].sort().slice(0, limit);

    const result = {
      total_indexed_fields: all.length,
      matched: matched.length,
      returned: fields.length,
      fields,
    };
    if (contains) result.contains = args.contains;
    if (matched.length > fields.length) {
      result.note =
        `${matched.length} fields matched; showing ${fields.length}. Narrow with \`contains\` ` +
        `or raise \`limit\`.`;
    }
    if (!contains && all.length > limit) {
      result.note =
        `This cluster indexes ${all.length} fields — far too many to list. Pass \`contains\` ` +
        `(e.g. "namespace", "pod", "level") to find the one you want.`;
    }
    if (matched.length === 0) {
      result.why_no_results =
        `No indexed field name contains "${args.contains}". Field names are case-sensitive and ` +
        `vary by shipper (e.g. namespace_name vs Pod_namespace). Try a shorter substring.`;
    }
    return jsonResult(result);
  } catch (error) {
    return errorResult(instance, "listing fields", error);
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
