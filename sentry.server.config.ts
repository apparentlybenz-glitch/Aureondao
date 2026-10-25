// Node.js server init (used by `next dev`). On Workers, `withSentry` in
// worker.ts creates the client and this only applies the release.
import * as Sentry from "@sentry/nextjs";
import { sentryDataCollection } from "./src/lib/sentry-options";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  dataCollection: sentryDataCollection,
});
