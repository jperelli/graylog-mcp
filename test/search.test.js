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

test("search merges newest-first, projects concise fields, and truncates", async () => {
  // Merges newest-first, projects high-signal fields, truncates long bodies,
  // and reports total_matched + note.
  const search = await h.call("search", { query: "*", streams: "s1,s2" });
  assert.equal(search.returned, 2);
  assert.equal(search.total_matched, 6, "sum of per-stream total_results (1 + 5)");
  assert.ok(search.note, "note present when total_matched exceeds returned");
  assert.equal(search.messages[0]._id, "m-s2", "newest (s2, 11:00) sorted first");
  assert.equal(search.messages[1]._id, "m-s1");
  assert.equal(search.messages[1]._index, "idx_s1", "index carried through");
  assert.equal(
    search.messages[1].extra_field,
    undefined,
    "concise projection drops low-signal fields",
  );
  assert.ok(
    search.messages[0].message.endsWith("chars — use get_message for the full body]"),
    "long body truncated with a marker",
  );
  assert.ok(
    search.messages[0].message.includes("truncated 500 chars"),
    "truncation reports dropped char count",
  );
});

test("search verbose returns every field, untruncated", async () => {
  const verbose = await h.call("search", { query: "*", streams: "s1", verbose: true });
  assert.equal(
    verbose.messages[0].extra_field,
    "should-be-dropped-by-concise",
    "verbose keeps all fields",
  );
  assert.equal(verbose.messages[0]._index, "idx_s1");
});

test("search survives a partial (403) fan-out failure", async () => {
  // A forbidden stream is excluded, not fatal.
  const partial = await h.call("search", { query: "*", streams: "s1,forbidden" });
  assert.equal(partial.returned, 1, "the readable stream's hit still comes back");
  assert.deepEqual(partial.failed_streams, ["forbidden"]);
  assert.ok(partial.warning?.includes("forbidden"), "warning names the failed stream");
});

test("search with from/to uses the absolute endpoint", async () => {
  const absolute = await h.call("search", {
    query: "*",
    streams: "s1",
    from: "2026-07-01 00:00:00",
    to: "2026-07-02 00:00:00",
  });
  assert.equal(
    absolute.messages[0]._id,
    "m-abs",
    "from/to hits the absolute endpoint, not relative",
  );
  assert.equal(absolute.messages[0]._index, "idx_abs");
});
