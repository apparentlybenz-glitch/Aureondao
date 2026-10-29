import type { LegalContent } from "./types";

export const riskDisclosure: LegalContent = {
  version: "1.0",
  effectiveDate: "October 2026",
  subtitle: "High-Risk Financial Warning",
  sections: [
    {
      heading: "1. Volatility & Loss of Principal",
      paragraphs: [
        "Multi-asset trading (including cryptocurrencies, equities, and derivatives) involves substantial risk. Asset prices fluctuate significantly within short timeframes. You may lose all capital invested.",
      ],
    },
    {
      heading: "2. Leverage & Margin Risks",
      paragraphs: [
        "Trading on leverage amplifies both potential gains and losses. Systemic price drops can trigger automatic margin calls and position liquidations faster than user intervention allows.",
      ],
    },
    {
      heading: "3. System & Latency Risks",
      paragraphs: [
        "Platform execution relies on electronic networks, API pipelines, and third-party liquidity venues. AureonX is not liable for losses caused by connectivity delays, network congestion, market outages, or scheduled maintenance windows.",
      ],
    },
  ],
};
