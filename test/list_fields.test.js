import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { FIELDS, startHarness } from "./helpers.js";

let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});

test("list_fields returns every indexed field", async () => {
  const fields = await h.call("list_fields");
  assert.equal(fields.total_indexed_fields, FIELDS.length);
  assert.deepEqual(fields.fields, [...FIELDS].sort());
});

test("list_fields narrows by substring, case-insensitively", async () => {
  // A real cluster indexes thousands of fields, several of them namespace-shaped
  // (namespace_name vs Pod_namespace), which is exactly why guessing fails.
  const fields = await h.call("list_fields", { contains: "NAMESPACE" });
  assert.deepEqual(fields.fields, ["Pod_namespace", "namespace_name"]);
  assert.equal(fields.matched, 2);
});

test("list_fields says so when a field name does not exist", async () => {
  const fields = await h.call("list_fields", { contains: "nonexistent" });
  assert.deepEqual(fields.fields, []);
  assert.match(fields.why_no_results, /case-sensitive/i);
});
