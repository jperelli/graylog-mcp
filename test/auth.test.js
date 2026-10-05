import assert from "node:assert/strict";
import { test } from "node:test";
import { startHarness } from "./helpers.js";

async function authHeadersSent(env) {
  const h = await startHarness(env);
  try {
    await h.call("list_streams");
    return h.authHeaders;
  } finally {
    await h.close();
  }
}

test("tokens go out as Graylog Basic auth by default", async () => {
  const expected = `Basic ${Buffer.from("test-token:token").toString("base64")}`;
  const sent = await authHeadersSent({});
  assert.ok(sent.length > 0);
  assert.ok(
    sent.every((a) => a === expected),
    JSON.stringify(sent),
  );
});

test("GRAYLOG_AUTH_INSTANCE_N=bearer sends the token as a bearer token", async () => {
  const sent = await authHeadersSent({ GRAYLOG_AUTH_INSTANCE_1: "bearer" });
  assert.ok(sent.length > 0);
  assert.ok(
    sent.every((a) => a === "Bearer test-token"),
    JSON.stringify(sent),
  );
});
