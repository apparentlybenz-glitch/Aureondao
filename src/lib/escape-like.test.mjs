import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeLike } from "./escape-like.ts";

test("escapeLike makes % and _ literal and escapes the backslash", () => {
  assert.equal(escapeLike("a%b_c"), "a\\%b\\_c");
  assert.equal(escapeLike("50\\50"), "50\\\\50");
  assert.equal(escapeLike("plain@mail.com"), "plain@mail.com");
});
