import assert from "node:assert/strict";
import { test } from "node:test";
import { BODY_MAX, bodyOk, isTopic, SUBJECT_MAX, subjectOk, ticketOk } from "./support-rules.ts";

test("isTopic accepts only the six topics", () => {
  for (const t of ["account", "balance_funding", "trading", "verification", "security", "other"]) assert.ok(isTopic(t));
  assert.equal(isTopic(""), false);
  assert.equal(isTopic("billing"), false);
});

test("subjectOk: 1 to 120 characters after trimming", () => {
  assert.ok(subjectOk("a"));
  assert.ok(subjectOk(`  ${"x".repeat(SUBJECT_MAX)}  `));
  assert.equal(subjectOk("x".repeat(SUBJECT_MAX + 1)), false);
  assert.equal(subjectOk(" \n\t "), false);
});

test("bodyOk: 1 to 2000 characters after trimming", () => {
  assert.ok(bodyOk("hello\n"));
  assert.ok(bodyOk("x".repeat(BODY_MAX)));
  assert.equal(bodyOk("x".repeat(BODY_MAX + 1)), false);
  assert.equal(bodyOk("\n\n"), false);
});

test("ticketOk needs all three fields", () => {
  assert.ok(ticketOk("trading", "Order", "Details"));
  assert.equal(ticketOk("", "Order", "Details"), false);
  assert.equal(ticketOk("trading", "", "Details"), false);
  assert.equal(ticketOk("trading", "Order", " "), false);
});
