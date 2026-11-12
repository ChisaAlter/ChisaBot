import assert from "node:assert/strict";
import { test } from "node:test";
import { FAILURE_TEXT_MAX, redactFailureText } from "../src/redact.mjs";

test("failure text loses keys, credentials and internal addresses, and is capped", () => {
  const out = redactFailureText(
    `400 Invalid input: content SECRET-sk-qa510 Authorization: Bearer abcdefghijklmnop api_key=k123456 postgres://app:p/w#1@db.example.com/x 10.1.2.3 8.8.8.8:53 fd00::12 [fe80::1]:80 localhost:3000 db.internal ${"x".repeat(1000)}`,
  );
  for (const leak of [
    "sk-qa510",
    "abcdefghijklmnop",
    "k123456",
    "p/w#1",
    "10.1.2.3",
    "8.8.8.8:53",
    "fd00::12",
    "fe80::1",
    "localhost",
    "db.internal",
  ])
    assert.ok(!out.includes(leak), leak);
  assert.ok(out.length <= FAILURE_TEXT_MAX + 1);
  assert.match(out, /^400 Invalid input/);
  assert.equal(redactFailureText("model x HTTP 429"), "model x HTTP 429");
  assert.equal(
    redactFailureText(redactFailureText("Bearer abcdefghijkl")),
    "Bearer ••••",
  );
});
