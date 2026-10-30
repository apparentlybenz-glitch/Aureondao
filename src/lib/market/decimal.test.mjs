import assert from "node:assert/strict";
import { test } from "node:test";
import { formatChange, formatMid, formatPrice, fractionToPercent, isPositiveDecimal, roundDecimal } from "./decimal.ts";

test("roundDecimal rounds half up on the string", () => {
  assert.equal(roundDecimal("80163.80000000", 2), "80163.80");
  assert.equal(roundDecimal("0.125", 2), "0.13");
  assert.equal(roundDecimal("0.124", 2), "0.12");
  assert.equal(roundDecimal("9.995", 2), "10.00");
  assert.equal(roundDecimal("1.5", 0), "2");
  assert.equal(roundDecimal("12", 3), "12.000");
  assert.equal(roundDecimal("-0.001", 2), "0.00");
  assert.equal(roundDecimal("-0.005", 2), "-0.01");
  assert.equal(roundDecimal("1e-7", 2), null);
  assert.equal(roundDecimal("", 2), null);
});

test("formatPrice groups thousands and uses the market decimals", () => {
  assert.equal(formatPrice("80163.80000000", 2), "80,163.80");
  assert.equal(formatPrice("0.00000440", 8), "0.00000440");
  assert.equal(formatPrice("0.000004393", 8), "0.00000439");
  assert.equal(formatPrice("1234567.891", 2), "1,234,567.89");
  assert.equal(formatPrice("abc", 2), "--");
});

test("formatChange signs and rounds a percent string", () => {
  assert.equal(formatChange("7.7886"), "+7.79%");
  assert.equal(formatChange("-0.312"), "-0.31%");
  assert.equal(formatChange("0.000"), "0.00%");
  assert.equal(formatChange("-0.001"), "0.00%");
});

test("fractionToPercent moves the decimal point two places", () => {
  assert.equal(fractionToPercent("-0.003"), "-0.3");
  assert.equal(fractionToPercent("0.0755"), "7.55");
  assert.equal(fractionToPercent("0.04477"), "4.477");
  assert.equal(fractionToPercent("0"), "0");
  assert.equal(fractionToPercent("-0.0000"), "0.00");
  assert.equal(fractionToPercent("1.25"), "125");
  assert.equal(fractionToPercent("n/a"), null);
});

test("isPositiveDecimal rejects zero, blanks and exponents", () => {
  assert.equal(isPositiveDecimal("0.00000001"), true);
  assert.equal(isPositiveDecimal("0.00000000"), false);
  assert.equal(isPositiveDecimal(""), false);
  assert.equal(isPositiveDecimal(null), false);
  assert.equal(isPositiveDecimal("1E-7"), false);
});

test("formatMid keeps the half-tick digit of a mid price and drops a trailing zero", () => {
  assert.equal(formatMid("0.000004515", 8), "0.000004515");
  assert.equal(formatMid("0.000004520", 8), "0.00000452");
  assert.equal(formatMid("84242.95", 2), "84,242.95");
  assert.equal(formatMid("84242.9", 2), "84,242.90");
  assert.equal(formatMid("84242.905", 2), "84,242.905");
  assert.equal(formatMid("1e-7", 8), "--");
});
