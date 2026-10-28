import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { COUNTRIES, COUNTRY_CODES, countryName } from "./countries.ts";

// The client list and private.is_country in the KYC migration must match, or the
// picker offers a country the server refuses (or hides one it accepts).
test("COUNTRY_CODES matches private.is_country in the KYC migration", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/20261027225746_kyc.sql", import.meta.url), "utf8");
  const start = sql.indexOf("create function private.is_country");
  const body = sql.slice(start, sql.indexOf("]::text[]", start));
  const fromSql = [...body.matchAll(/'([A-Z]{2})'/g)].map((m) => m[1]);
  assert.equal(fromSql.length, 249);
  assert.deepEqual([...COUNTRY_CODES].sort(), fromSql.sort());
});

test("every code has a name and the picker list is sorted by name", () => {
  assert.equal(new Set(COUNTRY_CODES).size, COUNTRY_CODES.length);
  for (const code of COUNTRY_CODES) assert.notEqual(countryName(code), code, code);
  const names = COUNTRIES.map((c) => c.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, "en")));
});
