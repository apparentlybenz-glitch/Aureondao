"use client";

import { useTranslations } from "next-intl";
import { useRpcMessage } from "@/components/app/use-rpc-message";

// Codes raised by submit_kyc and admin_review_kyc (Kyc.errors). Everything else
// (INVALID_ARGUMENT, FORBIDDEN, AAL2_REQUIRED, NOTE_REQUIRED, ...) falls through
// to the shared Errors copy.
const KYC_ERROR_CODES = [
  "KYC_PENDING",
  "KYC_INVALID_COUNTRY",
  "KYC_INVALID_NAME",
  "KYC_INVALID_DOB",
  "KYC_INVALID_CITY",
  "KYC_PATH_INVALID",
  "KYC_FILE_MISSING",
  "KYC_NOT_FOUND",
  "KYC_NOT_PENDING",
  "PROFILE_NOT_FOUND",
] as const;

export function useKycMessage() {
  const t = useTranslations("Kyc");
  const rpcMessage = useRpcMessage();
  return (error: { code?: string; message: string }): string => {
    const code = error.code === "P0001" ? KYC_ERROR_CODES.find((c) => c === error.message) : undefined;
    return code ? t(`errors.${code}`) : rpcMessage(error);
  };
}
