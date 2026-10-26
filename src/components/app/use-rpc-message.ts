"use client";

import { useTranslations } from "next-intl";
import { rpcErrorCode, serverAnswered } from "@/lib/rpc-error";

// Maps an RPC error to user copy. Raw database messages are never shown.
export function useRpcMessage() {
  const errors = useTranslations("Errors");
  const common = useTranslations("Common");
  return (error: { code?: string; message: string }): string => {
    const code = rpcErrorCode(error);
    if (code) return errors(code);
    if (!serverAnswered(error)) return errors("network");
    return common("genericError");
  };
}
