import assert from "node:assert/strict";
import { test } from "node:test";
import { maskEmail } from "./mask-email.ts";

test("maskEmail keeps two characters each side of the stars", () => {
  assert.equal(maskEmail("jane.doe@example.com"), "ja****oe@example.com");
  assert.equal(maskEmail("abcde@x.io"), "ab****de@x.io");
});

test("maskEmail never repeats characters of a short local part", () => {
  assert.equal(maskEmail("abcd@x.io"), "ab****@x.io");
  assert.equal(maskEmail("a@x.io"), "a****@x.io");
});

test("maskEmail leaves a value with no @ alone", () => {
  assert.equal(maskEmail("nobody"), "nobody");
});
