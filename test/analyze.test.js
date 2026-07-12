import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { HISTOGRAM, MATCHED_TOTAL, startHarness, TERMS } from "./helpers.js";

let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});

test("analyze returns top_values from the Views API", async () => {
  // Every stream goes into a single Views request, so counts come back whole
  // rather than needing a per-stream merge.
  const analyze = await h.call("analyze", { field: "source", streams: "s1,s2" });
  assert.equal(analyze.field, "source");
  assert.deepEqual(analyze.top_values, [
    { value: "api-1", count: TERMS["api-1"] },
    { value: "api-2", count: TERMS["api-2"] },
  ]);
  assert.equal(analyze.total_matched, MATCHED_TOTAL);
  // Whatever the top values don't account for: no value for the field, or past the cut-off.
  assert.equal(analyze.not_in_top_values, MATCHED_TOTAL - TERMS["api-1"] - TERMS["api-2"]);
});

test("analyze histogram returns ISO buckets", async () => {
  const histogram = await h.call("analyze", {
    field: "source",
    streams: "s1,s2",
    histogramInterval: "hour",
  });
  assert.equal(histogram.histogram.interval, "hour");
  assert.deepEqual(
    histogram.histogram.buckets,
    Object.entries(HISTOGRAM).map(([time, count]) => ({ time, count })),
  );
});

test("analyze valueContains discovers a value the caller only half-knows", async () => {
  // The case that sent the real agent in circles: it guessed a namespace name,
  // got 0 hits, and could not tell a wrong guess from missing logs. Elasticsearch
  // rejects `namespace_name:*catalogue*`, so this filters the buckets locally.
  const found = await h.call("analyze", {
    field: "namespace_name",
    streams: "s1",
    valueContains: "CATALOGUE", // case-insensitive
  });
  assert.deepEqual(
    found.top_values.map((v) => v.value),
    ["app-sockshop-catalogue-dev", "app-sockshop-catalogue-qa"],
    "only matching namespaces, still ordered by count",
  );
  assert.match(found.note, /leading wildcard/i);
});

test("analyze surfaces a leading-wildcard query as an error, not an empty result", async () => {
  // The Views API answers HTTP 200 with an `errors` array for this, which would
  // otherwise be misread as "no matches".
  const result = await h.callRaw("analyze", {
    field: "source",
    streams: "s1",
    query: "namespace_name:*catalogue*",
  });
  const text = result.content[0].text;
  assert.match(text, /not allowed as first character/i);
  assert.match(text, /valueContains/, "the error must point at the tool that does work");
});

test("analyze answers from the readable streams and reports the unreadable one", async () => {
  // The Views API takes all streams in one request, so an unreadable stream would
  // 403 the whole call. Its 403 names the offending streams, so they are dropped
  // and the call retried — the caller gets data AND the permission problem at once.
  const partial = await h.call("analyze", { field: "source", streams: "s1,forbidden" });
  assert.deepEqual(
    partial.top_values.map((v) => v.value),
    ["api-1", "api-2"],
    "the readable stream's aggregation still comes back",
  );
  assert.deepEqual(partial.failed_streams, ["forbidden"]);
  assert.deepEqual(partial.streams, ["s1"], "streams reflects what was actually searched");
  assert.match(partial.warning, /forbidden \(HTTP 403\)/);
});

test("analyze still fails when no stream is readable", async () => {
  const result = await h.callRaw("analyze", { field: "source", streams: "forbidden" });
  assert.match(result.content[0].text, /Error analyzing/);
});

test("analyze explains an empty breakdown instead of returning a bare empty list", async () => {
  const result = await h.call("analyze", { field: "unknown_field", streams: "s1" });
  assert.deepEqual(result.top_values, []);
  assert.match(result.why_no_results, /list_fields/);
});
