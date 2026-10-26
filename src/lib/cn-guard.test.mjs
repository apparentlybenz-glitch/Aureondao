import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

// shadcn 4.22's radix-nova registry items depend on the npm package "cn" and
// import from it; the CLI installs it and does not rewrite the import. The app
// uses cn() from @/lib/utils, so neither the package nor that import may stay.
const root = new URL("../..", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const cnImport = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']cn["']/;

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(e.name) ? [path] : [];
  });
}

test('package.json does not depend on the "cn" package', () => {
  assert.equal(pkg.dependencies?.cn, undefined, "remove cn from dependencies");
  assert.equal(pkg.devDependencies?.cn, undefined, "remove cn from devDependencies");
});

test('no file under src imports from "cn" (use @/lib/utils)', () => {
  const self = new URL(import.meta.url).pathname;
  const hits = sourceFiles(join(root, "src"))
    .filter((f) => f !== self && cnImport.test(readFileSync(f, "utf8")))
    .map((f) => relative(root, f));
  assert.deepEqual(hits, []);
});
