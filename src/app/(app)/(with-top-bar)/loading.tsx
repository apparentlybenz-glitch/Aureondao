import { getTranslations } from "next-intl/server";
import { Loading, Skeleton } from "@/components/ui/skeleton";

// Shown while a route in this group renders on the server (the admin pages check the admin row
// per request); the static pages are prefetched and rarely show it. A heading and list rows.
export default async function GroupLoading() {
  const c = await getTranslations("Common");
  return (
    <Loading label={c("loading")} className="space-y-4">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-12 w-full rounded-lg" />
      <Skeleton className="h-12 w-full rounded-lg" />
      <Skeleton className="h-12 w-full rounded-lg" />
    </Loading>
  );
}
