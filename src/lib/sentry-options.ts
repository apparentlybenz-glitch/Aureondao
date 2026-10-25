// Shared by every Sentry.init / withSentry call. Errors only: no user info,
// cookies, headers or bodies (login and password flows must never be sent).
export const sentryDataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
};
