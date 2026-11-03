import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { CURRENCY_FLAG, currencyIcon, instrumentParts } from "./forex-icons.ts";

const root = new URL("../../", import.meta.url);
const ENABLED = [
  "EUR-USD", "GBP-USD", "USD-JPY", "USD-CHF", "USD-CAD", "AUD-USD", "NZD-USD",
  "EUR-GBP", "EUR-JPY", "GBP-JPY", "AUD-JPY", "XAU-USD", "XAG-USD",
];
const DISABLED = ["EUR-CHF", "EUR-AUD", "GBP-AUD", "NZD-JPY"];

test("every seeded instrument maps to icons on both sides", () => {
  for (const id of [...ENABLED, ...DISABLED]) {
    const { base, quote } = instrumentParts(id);
    for (const code of [base, quote]) {
      assert.notEqual(currencyIcon(code).kind, "badge", `${id}: ${code} has no icon`);
    }
  }
  assert.deepEqual(currencyIcon("XAU"), { kind: "metal", metal: "gold" });
  assert.deepEqual(currencyIcon("XAG"), { kind: "metal", metal: "silver" });
});

test("every referenced flag file exists on disk", () => {
  for (const file of Object.values(CURRENCY_FLAG)) {
    assert.ok(existsSync(new URL(`public/icons/flags/${file}.svg`, root)), `${file}.svg is missing`);
  }
  assert.deepEqual(
    readdirSync(new URL("public/icons/flags/", root)).filter((f) => f.endsWith(".svg")).sort(),
    Object.values(CURRENCY_FLAG).map((f) => `${f}.svg`).sort(),
  );
});

test("an unknown currency falls back to the badge", () => {
  assert.deepEqual(currencyIcon("SEK"), { kind: "badge" });
  assert.deepEqual(currencyIcon(""), { kind: "badge" });
});

test("the component source has no http or https URL", () => {
  const src = readFileSync(new URL("src/components/forex/forex-icon.tsx", root), "utf8");
  assert.doesNotMatch(src, /https?:/);
});

test("the license sits next to the copied SVGs", () => {
  const license = readFileSync(new URL("public/icons/flags/LICENSE-circle-flags.txt", root), "utf8");
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) .* HatScripts/);
});
