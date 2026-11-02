"use client";

import { useLayoutEffect, useRef } from "react";
import { animate, inView, stagger } from "motion/react";
import { EASE_OUT } from "@/lib/motion";

// Scroll reveal for the landing page and Home only (never on a trading screen). If the wrapper
// starts below the fold, its children are hidden before the first paint and rise 12 px while
// fading in over 300 ms once a fifth of it is on screen, 40 ms apart, once. A wrapper already on
// screen at load renders as it is, with no reveal. Server HTML is always visible, so the content
// never depends on this running. Reduced motion: a fade only.
export function Reveal({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || el.getBoundingClientRect().top < window.innerHeight) return;
    const items = Array.from(el.children) as HTMLElement[];
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const item of items) {
      item.style.opacity = "0";
      if (!reduce) item.style.transform = "translateY(12px)";
    }
    const stop = inView(
      el,
      () => {
        stop();
        animate(items, reduce ? { opacity: 1 } : { opacity: 1, transform: "translateY(0px)" }, {
          duration: 0.3,
          ease: EASE_OUT,
          delay: stagger(0.04),
        });
      },
      { amount: 0.2 },
    );
    return () => {
      stop();
      for (const item of items) {
        item.style.opacity = "";
        item.style.transform = "";
      }
    };
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
