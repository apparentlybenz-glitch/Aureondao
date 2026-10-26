// Lets node:test import the extensionless relative specifiers the app code uses
// (tsc's bundler resolution) by retrying them with ".ts". Test-only; no packages.
import { register } from "node:module";

register("./resolve-ts.mjs", import.meta.url);
