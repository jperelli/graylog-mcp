import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { FULL_MESSAGE, MESSAGE_ID, MESSAGE_INDEX, startHarness } from "./helpers.js";

let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});

test("get_message returns the full document, untruncated", async () => {
  const message = await h.call("get_message", { messageId: MESSAGE_ID, index: MESSAGE_INDEX });
  assert.equal(message.index, MESSAGE_INDEX);
  assert.deepEqual(message.message, FULL_MESSAGE);
});
