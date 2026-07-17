import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DEFAULT_STREAM_ID, EMPTY_QUERY, startHarness, WILDCARD_HIT } from "./helpers.js";

// streams:"*" and the "remove matches from Default Stream" blind spot. The failure
// this guards against: a service routed to its own stream that removes its matches
// from the Default Stream is invisible to a Default-Stream-only search, so the
// agent (told the Default Stream is "everything") concludes the logs do not exist.

let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});

test('search streams:"*" reaches a stream that removes its matches from the Default Stream', async () => {
  // WILDCARD_HIT lives only in Zeta (remove-from-default). A Default-Stream-only
  // search never sees it; "*" expands to every readable stream and finds it via
  // the Views `messages` search type in ONE request (no per-stream fan-out).
  const all = await h.call("search", { query: "*", streams: "*" });
  assert.equal(all.returned, 1);
  assert.equal(all.total_matched, 1, "total comes from the rollup pivot riding along");
  assert.equal(all.messages[0]._id, WILDCARD_HIT.message._id);
  assert.equal(all.messages[0]._index, WILDCARD_HIT.index, "index carried for get_message");
  assert.equal(all.messages[0].extra_field, undefined, "concise projection still applies");
  assert.match(String(all.streams), /readable streams/, "streams summarised, not a giant id list");
});

test('search streams:"*" honors verbose and an explicit field list', async () => {
  const verbose = await h.call("search", { query: "*", streams: "*", verbose: true });
  assert.equal(verbose.messages[0].extra_field, "dropped-by-concise", "verbose keeps all fields");

  const picked = await h.call("search", { query: "*", streams: "*", fields: "source,msg" });
  assert.deepEqual(
    Object.keys(picked.messages[0]).sort(),
    ["_id", "_index", "msg", "source"],
    "explicit fields projected client-side, plus the get_message identifiers",
  );
});

test('analyze streams:"*" aggregates across every readable stream in one request', async () => {
  const agg = await h.call("analyze", { field: "source", streams: "*" });
  assert.deepEqual(
    agg.top_values.map((v) => v.value),
    ["api-1", "api-2"],
  );
  assert.match(String(agg.streams), /readable streams/, "streams summarised for the wildcard");
});

test("a Default-Stream-only search that finds nothing points at streams:*", async () => {
  // The window has data (infra logs) but not the wanted service, so diagnoseEmpty
  // blames the query AND flags that a dedicated stream may be removing its matches.
  const empty = await h.call("search", { query: EMPTY_QUERY, streams: DEFAULT_STREAM_ID });
  assert.equal(empty.total_matched, 0);
  assert.match(empty.why_no_results, /only the Default Stream/i);
  assert.match(empty.why_no_results, /streams:"\*"/, "offers the all-streams escape hatch");
});

test("list_streams reports which streams remove their matches from the Default Stream", async () => {
  const streams = await h.call("list_streams");
  assert.equal(
    streams.streams_removing_from_default,
    1,
    "Zeta removes-from-default, Alpha does not",
  );
  assert.match(streams.default_stream_note, /streams:"\*"/);
  const zeta = streams.streams.find((s) => s.title === "Zeta");
  assert.equal(zeta.removes_from_default_stream, true);
  const alpha = streams.streams.find((s) => s.title === "Alpha");
  assert.equal(alpha.removes_from_default_stream, undefined, "flag only surfaced when true");
});
