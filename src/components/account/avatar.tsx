import { UserRound } from "lucide-react";
import { cn } from "@/lib/utils";

// The default avatar. There is no upload.
export function Avatar({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("flex size-14 shrink-0 items-center justify-center rounded-full bg-muted", className)}>
      <UserRound className="size-1/2 text-muted-foreground" />
    </span>
  );
}
