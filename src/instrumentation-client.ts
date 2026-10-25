import * as Sentry from "@sentry/nextjs";
import { sentryDataCollection } from "@/lib/sentry-options";

// Errors only (no tracing), so no trace headers are added to any request.
// That keeps market-data fetches CORS-simple (docs/decisions.md C18).
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  dataCollection: sentryDataCollection,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
