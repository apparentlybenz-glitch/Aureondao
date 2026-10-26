import * as Sentry from "@sentry/nextjs";
import { sentryDataCollection } from "@/lib/sentry-options";

// Errors only (no tracesSampleRate). @sentry/nextjs still installs the browser
// tracing integration by default, but while tracePropagationTargets is unset it
// attaches sentry-trace and baggage headers to same-origin requests only
// (verified in @sentry/browser 11.9.0, tracing/request.js). Cross-origin market
// data calls stay plain GETs with no preflight (docs/decisions.md C18).
// If an OPTIONS request ever shows up for the Vision host, set
// tracePropagationTargets: [].
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  dataCollection: sentryDataCollection,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
