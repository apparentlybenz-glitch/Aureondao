"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { BrandMark } from "@/components/brand/brand-mark";
import { whenSplashReady } from "@/lib/splash";

// Launch splash, from the root layout: part of the server HTML, so it shows on full page loads
// only; the root layout stays mounted across client navigation, so it never shows again. The
// mark's ring draws once over 700 ms (CSS, so it runs before hydration). It fades out over 200 ms
// once the page has hydrated and the shell's session check has resolved (holdSplash), or at the
// 900 ms cap in CSS, whichever comes first, even mid-draw. It never takes pointer input.
// /offline is served without its stylesheet, so it gets none.
// Mirrors .splash in globals.css: the 900 ms cap and the 200 ms fade.
const CAP_MS = 900;
const FADE_MS = 200;

export function Splash() {
  const pathname = usePathname();
  const [phase, setPhase] = useState<"shown" | "leaving" | "gone">("shown");

  useEffect(() => {
    let stop = () => {};
    // One frame after hydration, so every mount effect (and its hold) has run.
    const frame = requestAnimationFrame(() => {
      stop = whenSplashReady(() => setPhase((p) => (p === "shown" ? "leaving" : p)));
    });
    // Fail-safe: removed at the cap plus the fade even if its CSS never arrives.
    const cap = setTimeout(() => setPhase("gone"), CAP_MS + FADE_MS);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(cap);
      stop();
    };
  }, []);

  // The fade normally ends in transitionend; this removes it even without the CSS transition.
  useEffect(() => {
    if (phase !== "leaving") return;
    const done = setTimeout(() => setPhase("gone"), FADE_MS);
    return () => clearTimeout(done);
  }, [phase]);

  if (phase === "gone" || pathname === "/offline") return null;
  return (
    <div
      aria-hidden="true"
      data-leaving={phase === "leaving" ? "" : undefined}
      onTransitionEnd={() => setPhase("gone")}
      onAnimationEnd={(e) => {
        if (e.animationName === "splash-cap") setPhase("gone");
      }}
      className="splash pointer-events-none fixed inset-0 z-[200] flex items-center justify-center bg-black"
    >
      <BrandMark variant="full" idPrefix="splash" size={96} ringClassName="splash-ring" className="size-24" />
    </div>
  );
}
