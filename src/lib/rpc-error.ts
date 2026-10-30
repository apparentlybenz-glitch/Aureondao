// RPCs raise their error codes as the message with SQLSTATE P0001.
export const RPC_ERROR_CODES = [
  "INSUFFICIENT_FUNDS",
  "SAME_WALLET",
  "INVALID_AMOUNT",
  "INVALID_ARGUMENT",
  "IDEMPOTENCY_CONFLICT",
  "WALLET_NOT_FOUND",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "AAL2_REQUIRED",
  "NOTE_REQUIRED",
  "PRICE_STALE",
  "INSUFFICIENT_ASSET",
  "BELOW_MIN_NOTIONAL",
  "INVALID_QTY",
  "INVALID_NUMBER",
  "MARKET_NOT_FOUND",
  "MARKET_DISABLED",
  "PERIOD_NOT_FOUND",
  "PERIOD_DISABLED",
  "BELOW_MIN_PREMIUM",
  "ACCOUNT_SUSPENDED",
  "SUPPORT_INVALID_TOPIC",
  "SUPPORT_INVALID_SUBJECT",
  "SUPPORT_INVALID_BODY",
  "SUPPORT_NOT_FOUND",
  "SUPPORT_CLOSED",
  "HEAD_ADMIN_PROTECTED",
] as const;
export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];

type ErrorLike = { code?: string; message: string };

export function rpcErrorCode(error: ErrorLike): RpcErrorCode | null {
  const code = RPC_ERROR_CODES.find((c) => c === error.message);
  return error.code === "P0001" && code ? code : null;
}

// True when the server answered (any Postgres/PostgREST code). A network
// failure has no code, so the request may or may not have run.
export function serverAnswered(error: ErrorLike): boolean {
  return Boolean(error.code);
}
