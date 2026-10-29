import type { LegalContent } from "./types";

export const licensesAndDisclosures: LegalContent = {
  version: "1.0",
  effectiveDate: "October 2026",
  sections: [
    {
      heading: "1. Regulatory Status",
      paragraphs: [
        "AureonX operates as a provider of financial and trading infrastructure software. Regulatory authorizations and license numbers vary by operating jurisdiction and asset class.",
      ],
    },
    {
      heading: "2. No Financial Advice",
      paragraphs: [
        "All content, market data, analysis tools, and indicators provided on the AureonX platform are for informational and educational purposes only and do not constitute financial, investment, or tax advice.",
      ],
    },
    {
      heading: "3. Conflict of Interest Disclosure",
      paragraphs: [
        "AureonX may utilize market makers, automated liquidity pools, and internal matching systems. Orders are routed according to our Best Execution Policy to seek optimal price performance across connected venues.",
      ],
    },
  ],
};
