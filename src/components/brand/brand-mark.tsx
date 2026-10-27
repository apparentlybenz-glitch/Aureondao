// The AureonX mark, inlined from brand/mark.svg (48 px and above) and
// brand/mark-small.svg (below 48 px). idPrefix keeps the SVG ids unique when
// the mark appears more than once on a page.
export function BrandMark({
  variant,
  idPrefix,
  className,
}: {
  variant: "full" | "small";
  idPrefix: string;
  className?: string;
}) {
  const id = (name: string) => `${idPrefix}-${name}`;
  const ref = (name: string) => `url(#${id(name)})`;
  const small = variant === "small";
  const stroke = small ? 32 : 14;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      role="img"
      aria-label="AureonX"
      className={className}
    >
      <defs>
        <path
          id={id("a")}
          d={
            small
              ? "M256 56 L314 170 L282 152 L384 420 L312 420 L256 262 L200 420 L128 420 L230 152 L198 170 Z"
              : "M256 72 L304 170 L273 152 L354 372 L308 372 L256 230 L204 372 L158 372 L239 152 L208 170 Z"
          }
        />
        <path
          id={id("o")}
          fillRule="evenodd"
          transform={small ? "rotate(-14 256 292)" : "rotate(-14 256 262)"}
          d={
            small
              ? "M20 292 A236 84 0 1 0 492 292 A236 84 0 1 0 20 292 Z M38 284 A224 50 0 1 0 486 284 A224 50 0 1 0 38 284 Z"
              : "M66 262 A190 62 0 1 0 446 262 A190 62 0 1 0 66 262 Z M72 252 A186 48 0 1 0 444 252 A186 48 0 1 0 72 252 Z"
          }
        />
        <clipPath id={id("front")}>
          <path d={small ? "M256 292 L512 228.17 L512 512 L256 512 Z" : "M256 262 L512 198.17 L512 512 L256 512 Z"} />
        </clipPath>
        <mask id={id("m-behind")} maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
          <rect width="512" height="512" fill="#fff" />
          <use href={`#${id("a")}`} fill="#000" stroke="#000" strokeWidth={stroke} strokeLinejoin="round" />
        </mask>
        <mask id={id("m-a")} maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
          <rect width="512" height="512" fill="#fff" />
          <g clipPath={ref("front")}>
            <use href={`#${id("o")}`} fill="#000" stroke="#000" strokeWidth={stroke} strokeLinejoin="round" />
          </g>
        </mask>
        {small ? null : (
          <mask id={id("m-ring")} maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
            <rect width="512" height="512" fill="#fff" />
            <use href={`#${id("a")}`} fill="#000" stroke="#000" strokeWidth={stroke} strokeLinejoin="round" />
            <use href={`#${id("o")}`} fill="#000" stroke="#000" strokeWidth={stroke} strokeLinejoin="round" />
          </mask>
        )}
      </defs>
      <circle cx="256" cy="256" r="256" fill="#050505" />
      {small ? null : (
        <circle cx="256" cy="256" r="176" fill="none" stroke="#1BA04A" strokeWidth="4" mask={ref("m-ring")} />
      )}
      <use href={`#${id("o")}`} fill="#1BA04A" mask={ref("m-behind")} />
      <use href={`#${id("a")}`} fill="#1BA04A" mask={ref("m-a")} />
      <use href={`#${id("o")}`} fill="#1BA04A" clipPath={ref("front")} />
      {small ? null : (
        <>
          <path
            d="M150 214 Q153.2 232.8 168 236 Q153.2 239.2 150 258 Q146.8 239.2 132 236 Q146.8 232.8 150 214 Z"
            fill="#1BA04A"
          />
          <circle cx="174" cy="178" r="4" fill="#1BA04A" />
          <circle cx="346" cy="196" r="3.5" fill="#1BA04A" />
          <circle cx="392" cy="330" r="3.5" fill="#1BA04A" />
          <circle cx="256" cy="268" r="3" fill="#1BA04A" />
          <circle cx="150" cy="318" r="3" fill="#1BA04A" />
          <circle cx="330" cy="400" r="3" fill="#1BA04A" />
        </>
      )}
    </svg>
  );
}
