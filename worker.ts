// Worker entry: wraps the handler OpenNext generates so server errors on
// Workers reach Sentry. Reads SENTRY_DSN from the Worker env; without it the
// SDK stays disabled. Tracing is off (no tracesSampleRate) to keep CPU flat.
import * as Sentry from "@sentry/nextjs/cloudflare";
import handler from "./.open-next/worker.js";
import { sentryDataCollection } from "./src/lib/sentry-options";

type Env = { SENTRY_DSN?: string };

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    dataCollection: sentryDataCollection,
  }),
  handler,
);
