import assert from "node:assert/strict";
import { test } from "node:test";
import { birthDateOk, cityOk, latestBirthDate, MAX_PHOTO_BYTES, nameOk, photoProblem } from "./kyc-rules.ts";

test("photoProblem allows JPEG, PNG and WebP up to 5 MB", () => {
  assert.equal(photoProblem({ type: "image/jpeg", size: 1000 }), null);
  assert.equal(photoProblem({ type: "image/png", size: MAX_PHOTO_BYTES }), null);
  assert.equal(photoProblem({ type: "image/webp", size: 1 }), null);
  assert.equal(photoProblem({ type: "image/webp", size: MAX_PHOTO_BYTES + 1 }), "size");
  assert.equal(photoProblem({ type: "application/pdf", size: 1000 }), "type");
  assert.equal(photoProblem({ type: "image/gif", size: 1000 }), "type");
  assert.equal(photoProblem({ type: "", size: 1000 }), "type");
});

test("latestBirthDate is 18 years back, Feb 29 falling to Feb 28", () => {
  assert.equal(latestBirthDate(new Date("2026-10-27T23:00:00Z")), "2008-10-27");
  assert.equal(latestBirthDate(new Date("2028-02-29T12:00:00Z")), "2010-02-28");
});

test("birthDateOk: after 1900-01-01 and at least 18 years ago", () => {
  const today = new Date("2026-10-27T12:00:00Z");
  assert.equal(birthDateOk("2008-10-27", today), true);
  assert.equal(birthDateOk("2008-10-28", today), false);
  assert.equal(birthDateOk("1900-01-01", today), false);
  assert.equal(birthDateOk("1900-01-02", today), true);
  assert.equal(birthDateOk("", today), false);
});

test("name 2 to 100 and city 1 to 80 characters, trimmed", () => {
  assert.equal(nameOk(" A "), false);
  assert.equal(nameOk("Al"), true);
  assert.equal(nameOk("x".repeat(101)), false);
  assert.equal(cityOk("  "), false);
  assert.equal(cityOk("Rome"), true);
  assert.equal(cityOk("x".repeat(81)), false);
});
