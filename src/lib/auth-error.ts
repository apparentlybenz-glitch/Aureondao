// Supabase Auth error codes mapped to keys of the AuthErrors messages. Anything
// not listed falls back to the generic message; error.message is never shown.
const CODE_KEYS = {
  invalid_credentials: "invalidCredentials",
  user_already_exists: "userExists",
  email_exists: "userExists",
  weak_password: "weakPassword",
  same_password: "samePassword",
  over_request_rate_limit: "rateLimited",
  over_email_send_rate_limit: "rateLimited",
  over_sms_send_rate_limit: "rateLimited",
  mfa_verification_failed: "mfaFailed",
  mfa_challenge_expired: "codeExpired",
  otp_expired: "codeExpired",
  session_expired: "sessionExpired",
  session_not_found: "sessionExpired",
  refresh_token_not_found: "sessionExpired",
  signup_disabled: "signupDisabled",
} as const;

export type AuthErrorKey = (typeof CODE_KEYS)[keyof typeof CODE_KEYS] | "network";

type AuthErrorLike = { code?: string; name?: string; status?: number };

export function authErrorKey(error: AuthErrorLike): AuthErrorKey | null {
  if (error.name === "AuthRetryableFetchError" || error.status === 0) return "network";
  if (error.code && error.code in CODE_KEYS) return CODE_KEYS[error.code as keyof typeof CODE_KEYS];
  return null;
}
