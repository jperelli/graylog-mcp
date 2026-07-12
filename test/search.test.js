import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { EMPTY_QUERY, JOURNAL, STALE_STREAM, STALE_TIMESTAMP, startHarness } from "./helpers.js";

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
    search.messages[0].message.endsWith("or use get_message for the full body]"),
    "long body truncated with a marker",
  );
  assert.ok(
    search.messages[0].message.includes("truncated 2000 chars"),
    "truncation reports dropped char count",
  );
});

test("search keeps the parsed JSON fields a shipper extracted", async () => {
  // pino-style lines are parsed into msg/name fields. They are the summary of the
  // event, and cheap; the raw body that contains them is neither. Dropping them
  // from the projection is what forced an agent to read 2 KB of JSON per hit.
  const search = await h.call("search", { query: "*", streams: "s1" });
  assert.equal(search.messages[0].msg, "Error");
  assert.equal(search.messages[0].name, "CatalogueService");
});

test("search truncates the raw body at messageChars", async () => {
  const wide = await h.call("search", { query: "*", streams: "s2", messageChars: 2400 });
  assert.ok(
    wide.messages[0].message.includes("truncated 100 chars"),
    "messageChars raises the cap for the rare case the detail is only in the raw body",
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

test("a zero-result search blames the query when the window has data", async () => {
  // The window holds messages, so the streams and time range are fine and the
  // query must be at fault. Without this, a bad field name and an empty window
  // are indistinguishable.
  const empty = await h.call("search", { query: EMPTY_QUERY, streams: "s1" });
  assert.equal(empty.total_matched, 0);
  assert.match(empty.why_no_results, /query itself is almost certainly wrong/i);
  assert.match(empty.why_no_results, /list_fields/);
});

test("a zero-result search reports indexing lag rather than 'no logs'", async () => {
  // The failure that derailed the real session: Graylog had received the logs but
  // was ~2.5h behind on INDEXING them, so a correct query truthfully matched 0.
  // The newest indexed message is hours old, which is the tell.
  const empty = await h.call("search", { query: "*", streams: STALE_STREAM });
  assert.equal(empty.total_matched, 0);
  assert.match(empty.why_no_results, /still INDEXING/i);
  assert.ok(
    empty.why_no_results.includes(STALE_TIMESTAMP),
    "names the newest message actually indexed, so the agent can search before it",
  );
  assert.match(empty.why_no_results, /3\.0h old/, "quantifies how far behind indexing is");
  assert.ok(
    empty.why_no_results.includes(JOURNAL.uncommitted_journal_entries.toLocaleString()),
    "backs the diagnosis with the journal backlog",
  );
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
