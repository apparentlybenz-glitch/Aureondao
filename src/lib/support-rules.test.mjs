import assert from "node:assert/strict";
import { test } from "node:test";
import { BODY_MAX, bodyOk } from "./support-rules.ts";

test("bodyOk: 1 to 2000 characters after trimming", () => {
  assert.ok(bodyOk("hello\n"));
  assert.ok(bodyOk("x".repeat(BODY_MAX)));
  assert.equal(bodyOk("x".repeat(BODY_MAX + 1)), false);
  assert.equal(bodyOk("\n\n"), false);
});
