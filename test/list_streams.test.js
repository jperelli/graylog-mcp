import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DEFAULT_STREAM_ID, startHarness } from "./helpers.js";

let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});

test("list_streams pins the default stream first and sorts the rest by title", async () => {
  const streams = await h.call("list_streams");
  assert.equal(streams.total_readable, 3, "default stream counted alongside the two returned");
  assert.equal(streams.default_stream_id, DEFAULT_STREAM_ID);
  assert.deepEqual(
    streams.streams.map((s) => s.title),
    ["All messages", "Alpha", "Zeta"],
    "default stream first — it is the one callers almost always want — then sorted by title",
  );
});

test("list_streams honors titleContains", async () => {
  const filtered = await h.call("list_streams", { titleContains: "alp" });
  assert.deepEqual(
    filtered.streams.map((s) => s.title),
    ["Alpha"],
    "only titles containing 'alp'",
  );
});

test("list_streams caps output and points at the default stream", async () => {
  // A real cluster has thousands of streams; dumping them all blew the context
  // budget and spilled the tool result to a file.
  const capped = await h.call("list_streams", { limit: 1 });
  assert.equal(capped.returned, 2, "the cap applies to named streams; the default is never cut");
  assert.match(capped.note, /Narrow with `titleContains`/);
  assert.ok(capped.note.includes(DEFAULT_STREAM_ID), "offers the default stream as the way out");
});

test("list_streams explains an empty filter result", async () => {
  const none = await h.call("list_streams", { titleContains: "nope" });
  assert.equal(none.matched, 0);
  assert.ok(none.why_no_results.includes(DEFAULT_STREAM_ID));
});
