import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startHarness } from "./helpers.js";

let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});

test("analyze returns summed top_values", async () => {
  // Terms from both mock streams are summed per value.
  const analyze = await h.call("analyze", { field: "source", streams: "s1,s2" });
  assert.equal(analyze.field, "source");
  assert.deepEqual(analyze.top_values, [
    { value: "api-1", count: 14 }, // 7 per stream × 2 streams
    { value: "api-2", count: 6 },
  ]);
  assert.equal(analyze.missing, 2);
  assert.equal(analyze.other, 4);
});

test("analyze histogram sums buckets across streams and formats ISO times", async () => {
  // Buckets summed per stream, unix seconds -> ISO.
  const histogram = await h.call("analyze", {
    field: "source",
    streams: "s1,s2",
    histogramInterval: "hour",
  });
  assert.equal(histogram.histogram.interval, "hour");
  assert.deepEqual(
    histogram.histogram.buckets,
    [
      { time: new Date(1751328000 * 1000).toISOString(), count: 6 }, // 3 per stream × 2
      { time: new Date(1751331600 * 1000).toISOString(), count: 10 }, // 5 per stream × 2
    ],
    "buckets summed across streams, sorted ascending, timestamps in ISO",
  );
});
