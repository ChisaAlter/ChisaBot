import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelBreakers } from "../src/model-router.mjs";

test("breaker opens on failure, doubles its cooldown up to the cap, and closes on success", () => {
  let now = 0;
  const breakers = new ModelBreakers(() => now);
  assert.equal(breakers.cooling("m"), undefined);
  breakers.fail("m", "TIMEOUT");
  assert.ok(breakers.cooling("m"));
  now = 59_999;
  assert.ok(breakers.cooling("m"));
  now = 60_000;
  assert.equal(breakers.cooling("m"), undefined);
  // One turn probes; while it is in flight others keep skipping the model.
  breakers.probe("m");
  assert.ok(breakers.cooling("m"));
  breakers.fail("m", "TIMEOUT");
  now += 119_999;
  assert.ok(breakers.cooling("m"));
  now += 1;
  assert.equal(breakers.cooling("m"), undefined);
  for (let n = 0; n < 6; n++) {
    breakers.fail("m", "SERVER");
    const entry = breakers.cooling("m");
    assert.ok(entry.openUntil - now <= 600_000);
    now = entry.openUntil;
  }
  breakers.ok("m");
  assert.equal(breakers.cooling("m"), undefined);
  breakers.fail("m", "SERVER");
  assert.equal(breakers.cooling("m").openUntil - now, 60_000);
});

test("a probe that never reports stops gating after five minutes", () => {
  let now = 0;
  const breakers = new ModelBreakers(() => now);
  breakers.fail("m", "TIMEOUT");
  now = 60_000;
  breakers.probe("m");
  now = 60_000 + 299_999;
  assert.ok(breakers.cooling("m"));
  now += 1;
  assert.equal(breakers.cooling("m"), undefined);
});
