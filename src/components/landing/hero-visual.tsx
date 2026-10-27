import { BrandMark } from "@/components/brand/brand-mark";

// Decorative hero art: the full mark on a soft brand-green glow, inside two
// tilted orbit rings. The rings and the glow are page backdrop; the mark itself
// is drawn unchanged.
export function HeroVisual() {
  return (
    <div aria-hidden="true" className="relative mx-auto aspect-square w-full max-w-[20rem] md:max-w-[26rem]">
      <div className="absolute inset-[-8%] rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--primary)_32%,transparent),transparent)]" />
      <svg viewBox="0 0 400 400" fill="none" className="absolute inset-0 size-full">
        <g transform="rotate(-14 200 200)" className="stroke-primary">
          <ellipse cx="200" cy="200" rx="196" ry="66" strokeOpacity="0.55" strokeWidth="1.5" />
          <ellipse cx="200" cy="200" rx="170" ry="52" strokeOpacity="0.25" strokeWidth="1" />
          <circle cx="372" cy="170" r="5" className="fill-primary" stroke="none" />
          <circle cx="40" cy="226" r="3.5" className="fill-primary" stroke="none" />
          <circle cx="318" cy="238" r="2.5" className="fill-primary" stroke="none" />
        </g>
      </svg>
      <BrandMark variant="full" idPrefix="hero" className="absolute inset-[17%] size-[66%]" />
    </div>
  );
}
