import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { THEME_COLORS, THEME_KEY, THEME_SCRIPT } from "./theme.ts";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

// The body of the first rule that starts with the selector, up to its closing brace.
function block(selector) {
  const start = css.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, `${selector} block`);
  return css.slice(start, css.indexOf("\n}", start));
}

test("the browser chrome colors equal --background in each theme", () => {
  assert.match(block(":root"), new RegExp(`--background: ${THEME_COLORS.light};`));
  assert.match(block(".dark"), new RegExp(`--background: ${THEME_COLORS.dark};`));
});

test("both themes define every token the other defines", () => {
  const names = (b) => new Set([...b.matchAll(/^\s+(--[\w-]+):/gm)].map((m) => m[1]));
  const light = names(block(":root"));
  const dark = names(block(".dark"));
  // --radius is the one non-color token in the :root block and does not vary by theme.
  light.delete("--radius");
  for (const name of dark) assert.ok(light.has(name), `${name} missing from :root`);
  for (const name of light) assert.ok(dark.has(name), `${name} missing from .dark`);
});

test("the head script falls back to dark and reads the stored key", () => {
  assert.ok(THEME_SCRIPT.includes(JSON.stringify(THEME_KEY)));
  assert.ok(THEME_SCRIPT.includes('var t="dark"'));
  assert.ok(THEME_SCRIPT.includes("catch(e){}"));
});
