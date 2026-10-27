"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Headset } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

// Floating support button for full-screen trading screens (they have no top
// bar). Fixed above the tab bar, bottom right. It fades out while an element
// marked data-fab-avoid (the screen's confirm button) scrolls underneath it,
// so it never covers that button.
export function SupportFab() {
  const t = useTranslations("Shell");
  const ref = useRef<HTMLAnchorElement>(null);
  const [covered, setCovered] = useState(false);

  useEffect(() => {
    let frame = 0;
    const check = () => {
      frame = 0;
      const fab = ref.current?.getBoundingClientRect();
      if (!fab) return;
      const hit = Array.from(document.querySelectorAll("[data-fab-avoid]")).some((el) => {
        const r = el.getBoundingClientRect();
        return r.bottom > fab.top && r.top < fab.bottom && r.right > fab.left && r.left < fab.right;
      });
      setCovered(hit);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, []);

  return (
    <Link
      ref={ref}
      href="/support"
      aria-label={t("support")}
      aria-hidden={covered || undefined}
      tabIndex={covered ? -1 : undefined}
      className={cn(
        "fixed right-4 bottom-[calc(var(--tab-bar-h)+0.75rem+var(--safe-b))] z-30 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-opacity",
        covered && "pointer-events-none opacity-0",
      )}
    >
      <Headset className="size-6" />
    </Link>
  );
}
