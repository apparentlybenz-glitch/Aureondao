import { BrandMark } from "@/components/brand/brand-mark";

// Decorative market backdrop for the auth screens. Static markup, no client JS.
// Only transform animates (see .auth-bg-* in globals.css), and every animation
// stops under prefers-reduced-motion.

// One tile of the price line, 1200 wide. It starts and ends at y 180 so two
// tiles side by side loop without a seam.
const LINE =
  "M0 180 L80 150 L150 165 L240 110 L320 130 L410 80 L500 120 L580 100 L680 160 L770 140 L860 190 L950 150 L1050 175 L1130 140 L1200 180";

// Candles as [x, top, height, up].
const CANDLES: [number, number, number, boolean][] = [
  [60, 150, 40, true],
  [190, 120, 50, false],
  [300, 105, 45, true],
  [430, 90, 55, true],
  [560, 105, 40, false],
  [690, 140, 50, false],
  [800, 130, 45, true],
  [910, 150, 50, false],
  [1030, 150, 35, true],
  [1130, 125, 40, true],
];

export function AuthBackground() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 min-h-dvh overflow-hidden bg-background"
    >
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_45%_at_50%_30%,color-mix(in_oklch,var(--primary)_16%,transparent),transparent)]" />
      <div className="absolute inset-0 opacity-25 [background-image:linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [background-size:48px_48px] [mask-image:radial-gradient(ellipse_at_center,#000,transparent_72%)]" />
      <div className="absolute -top-[20%] -right-[35%] opacity-[0.07]">
        <BrandMark
          variant="full"
          idPrefix="auth-bg"
          size={900}
          className="auth-bg-orbit size-[min(140vw,900px)]"
        />
      </div>
      <div className="absolute inset-x-0 bottom-0 h-1/2">
        <div className="auth-bg-drift h-full w-[200%]">
          <svg viewBox="0 0 2400 300" preserveAspectRatio="none" className="size-full">
            <defs>
              <linearGradient id="auth-bg-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--primary)" stopOpacity="0.14" />
                <stop offset="1" stopColor="var(--primary)" stopOpacity="0" />
              </linearGradient>
              <g id="auth-bg-tile">
                <g opacity="0.14">
                  {CANDLES.map(([x, top, h, up]) => (
                    <g key={x} stroke={up ? "var(--up)" : "var(--down)"} fill={up ? "var(--up)" : "var(--down)"}>
                      <line x1={x + 6} x2={x + 6} y1={top - 12} y2={top + h + 12} strokeWidth="2" />
                      <rect x={x} y={top} width="12" height={h} stroke="none" />
                    </g>
                  ))}
                </g>
                <path d={`${LINE} L1200 300 L0 300 Z`} fill="url(#auth-bg-area)" />
                <path d={LINE} fill="none" stroke="var(--primary)" strokeOpacity="0.18" strokeWidth="9" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                <path d={LINE} fill="none" stroke="var(--primary)" strokeOpacity="0.75" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
              </g>
            </defs>
            <use href="#auth-bg-tile" />
            <use href="#auth-bg-tile" x="1200" />
          </svg>
        </div>
      </div>
    </div>
  );
}
