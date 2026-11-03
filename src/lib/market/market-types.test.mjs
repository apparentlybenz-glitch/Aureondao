import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { MARKET_TYPES, parseMarketType } from "./market-types.ts";

const read = (p) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

test("the type list is exactly Spot and Forex", () => {
  assert.deepEqual([...MARKET_TYPES], ["spot", "forex"]);
  const messages = JSON.parse(read("messages/en.json"));
  assert.deepEqual(Object.keys(messages.Market.types).filter((k) => k !== "label"), ["spot", "forex"]);
});

test("a stale or unknown type falls back to Spot", () => {
  assert.equal(parseMarketType("options"), "spot");
  assert.equal(parseMarketType("FOREX"), "spot");
  assert.equal(parseMarketType(""), "spot");
  assert.equal(parseMarketType(null), "spot");
  assert.equal(parseMarketType(undefined), "spot");
  assert.equal(parseMarketType("forex"), "forex");
  assert.equal(parseMarketType("spot"), "spot");
});

test("the 24 h change selection is shared with the terminal, not duplicated", () => {
  const math = read("src/lib/forex-math.ts");
  assert.equal((math.match(/export function dayAgoPrint/g) ?? []).length, 1);
  assert.equal((math.match(/export function fxChangePercent/g) ?? []).length, 1);
  assert.match(read("src/lib/forex.ts"), /dayAgoPrint\(/);
  for (const file of ["src/components/forex/forex-terminal.tsx", "src/components/market/forex-market-list.tsx"]) {
    const src = read(file);
    assert.match(src, /fxChangePercent\(/, file);
    assert.doesNotMatch(src, /[^x]changePercent\(/, `${file} must not compute the change itself`);
  }
});
