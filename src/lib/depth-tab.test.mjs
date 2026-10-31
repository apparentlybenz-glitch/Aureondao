import assert from "node:assert/strict";
import { test } from "node:test";
import { tabAfterOrder } from "./depth-tab.ts";

test("a successful order moves Book to Trades", () => {
  assert.equal(tabAfterOrder("book"), "trades");
});

test("any other tab stays", () => {
  assert.equal(tabAfterOrder("trades"), "trades");
  assert.equal(tabAfterOrder("orders"), "orders");
});
