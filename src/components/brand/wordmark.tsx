// The AureonX wordmark, inlined from brand/wordmark.svg. Letters use the text
// primary token and the X the brand green, matching the master.
export function Wordmark({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 544.44 101.6"
      role="img"
      aria-label="AureonX"
      className={className}
    >
      <path
        className="fill-foreground"
        fillRule="evenodd"
        d="M0 100 L46 0 L92 100 L75.49 100 L64.36 75.8 L27.64 75.8 L16.51 100 Z M46 35.89 L58.01 62 L33.99 62 Z M154 28 L154 100 L139 100 L139 95.55 A31 31 0 0 1 92 69 L92 28 L107 28 L107 69 A16 16 0 0 0 139 69 L139 28 Z M163 100 L163 28 L178 28 L178 32.45 A31 31 0 0 1 217.04 38.26 L205.89 48.29 A16 16 0 0 0 178 59 L178 100 Z M294.6 70.9 A37.6 37.6 0 1 0 286.44 88.17 L274.49 78.14 A22 22 0 0 1 236.75 70.9 Z M236.75 57.1 A22 22 0 0 1 278.53 57.1 Z M303.24 64 A37.6 37.6 0 1 0 378.44 64 A37.6 37.6 0 1 0 303.24 64 Z M318.84 64 A22 22 0 1 0 362.84 64 A22 22 0 1 0 318.84 64 Z M387.44 100 L387.44 28 L402.44 28 L402.44 32.45 A31 31 0 0 1 449.44 59 L449.44 100 L434.44 100 L434.44 59 A16 16 0 0 0 402.44 59 L402.44 100 Z"
      />
      <path
        className="fill-primary"
        d="M460.44 0 L479.44 0 L502.44 35.38 L525.44 0 L544.44 0 L511.94 50 L544.44 100 L525.44 100 L502.44 64.62 L479.44 100 L460.44 100 L492.94 50 Z"
      />
    </svg>
  );
}
