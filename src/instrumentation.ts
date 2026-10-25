import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
  }
}

// Reports errors from Server Components, route handlers and server actions.
export const onRequestError = Sentry.captureRequestError;
