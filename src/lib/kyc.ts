"use client";

import { useCallback, useEffect, useState } from "react";
import { onVisible } from "@/lib/on-visible";
import { createClient } from "@/lib/supabase/client";

export const KYC_BUCKET = "kyc-photos";
export const DOCUMENT_TYPES = ["passport", "national_id", "drivers_license"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const KYC_STATUSES = ["pending", "approved", "rejected"] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];
// "none" is the client's name for a user with no submission yet.
export type KycState = KycStatus | "none";

export type KycSubmission = {
  id: string;
  user_id: string;
  country: string;
  document_type: DocumentType;
  full_name: string;
  date_of_birth: string;
  city: string;
  photo_path: string;
  status: KycStatus;
  rejection_reason: string | null;
  submitted_at: string;
  decided_at: string | null;
};

export const KYC_SELECT =
  "id, user_id, country, document_type, full_name, date_of_birth, city, photo_path, status, rejection_reason, submitted_at, decided_at";

export type OwnKyc = { userId: string; current: KycSubmission | null };

// The signed-in user's latest submission (kyc_current), or null when not started.
// The view is filtered by user id because an admin reads every row.
// Reloads when the tab becomes visible; undefined while loading, null if it failed.
export function useOwnKyc(): { kyc: OwnKyc | null | undefined; reload: () => Promise<void> } {
  const [kyc, setKyc] = useState<OwnKyc | null | undefined>(undefined);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data: session } = await supabase.auth.getSession();
    const userId = session.session?.user.id;
    if (!userId) return setKyc(null);
    const { data, error } = await supabase
      .from("kyc_current")
      .select(KYC_SELECT)
      .eq("user_id", userId)
      .maybeSingle()
      .overrideTypes<KycSubmission, { merge: false }>();
    setKyc(error ? null : { userId, current: data });
  }, []);

  useEffect(() => {
    let active = true;
    const run = () => void load().catch(() => active && setKyc(null));
    run();
    const stop = onVisible(run);
    return () => {
      active = false;
      stop();
    };
  }, [load]);

  return { kyc, reload: load };
}

export function kycState(current: KycSubmission | null): KycState {
  return current?.status ?? "none";
}
