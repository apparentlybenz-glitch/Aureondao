import assert from "node:assert/strict";
import { test } from "node:test";
import { rankMarkets } from "./rank.ts";

const m = (id, sortOrder) => ({ id, sortOrder });
const t = (changePct, quoteVolume) => ({ changePct, quoteVolume });
const markets = [m("A", 1), m("B", 2), m("C", 3), m("D", 4)];
const tickers = { A: t("1.5", "100"), B: t("-2", "900"), C: t("7", "50") };

test("popular sorts by quote volume, missing tickers last", () => {
  assert.deepEqual(rankMarkets(markets, tickers, "popular").map((x) => x.id), ["B", "A", "C", "D"]);
});

test("gainer sorts by change descending and down ascending", () => {
  assert.deepEqual(rankMarkets(markets, tickers, "gainer").map((x) => x.id), ["C", "A", "B", "D"]);
  assert.deepEqual(rankMarkets(markets, tickers, "down").map((x) => x.id), ["B", "A", "C", "D"]);
});
