import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { RPC_ERROR_CODES } from "./rpc-error.ts";

const root = new URL("../../", import.meta.url);
const messages = JSON.parse(readFileSync(new URL("messages/en.json", root), "utf8"));
const dir = new URL("supabase/migrations/", root);
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

// The body of the newest definition of a function: from its header to the next "$$;".
function latestBody(header) {
  let found = null;
  for (const f of files) {
    const sql = readFileSync(new URL(f, dir), "utf8");
    const start = sql.indexOf(header);
    if (start === -1) continue;
    const end = sql.indexOf("$$;", sql.indexOf("as $$", start));
    found = sql.slice(start, end);
  }
  assert.ok(found, `${header} not found in the migrations`);
  return found;
}

const raised = (body) => [...body.matchAll(/raise exception '([A-Z0-9_]+)'/g)].map((m) => m[1]);

test("every error open_fx_position can raise has client wording", () => {
  const codes = new Set([
    ...raised(latestBody("create or replace function public.open_fx_position(")),
    // assert_active runs first
    ...raised(latestBody("create or replace function private.assert_active(")),
  ]);
  assert.ok(codes.size >= 14, `expected the full set, got ${[...codes].join(", ")}`);
  const ticket = readFileSync(new URL("src/components/forex/forex-ticket.tsx", root), "utf8");
  for (const code of codes) {
    assert.ok(RPC_ERROR_CODES.includes(code), `${code} is missing from RPC_ERROR_CODES`);
    const forex = messages.Forex.errors[code];
    const generic = messages.Errors[code];
    assert.ok(forex || generic, `${code} has no Forex.errors or Errors wording`);
    if (forex) assert.match(ticket, new RegExp(`case "${code}"`), `${code} is not handled in the ticket`);
  }
});

test("MARKET_CLOSED and PRICE_STALE read as specified", () => {
  assert.ok(RPC_ERROR_CODES.includes("MARKET_CLOSED"));
  assert.equal(messages.Forex.errors.PRICE_STALE, "Prices are updating. Try again in a minute.");
  assert.match(messages.Forex.closed, /^Forex is closed\. It opens again \{weekday\} at \{time\} ET\.$/);
  assert.match(
    messages.Forex.crossing,
    /^A new position cannot finish before Forex closes at \{time\} ET\. Try again when it reopens\.$/,
  );
});

test("Bills labels for the Forex ledger kinds", () => {
  assert.equal(messages.Bills.kind.forex_margin, "Forex premium");
  assert.equal(messages.Bills.kind.forex_close, "Forex settlement");
  assert.equal(messages.Bills.kind.forex_refund, "Forex refund");
});
