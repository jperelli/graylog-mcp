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

test("list_streams injects the default stream and sorts by title", async () => {
  const streams = await h.call("list_streams");
  assert.equal(streams.total, 3, "default stream should be injected alongside the two returned");
  assert.deepEqual(
    streams.streams.map((s) => s.title),
    ["All messages", "Alpha", "Zeta"],
    "sorted by title",
  );
  assert.ok(
    streams.streams.some((s) => s.id === DEFAULT_STREAM_ID),
    "default stream present",
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
