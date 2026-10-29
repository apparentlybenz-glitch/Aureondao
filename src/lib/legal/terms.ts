import type { LegalContent } from "./types";

export const terms: LegalContent = {
  version: "1.0",
  effectiveDate: "October 2026",
  sections: [
    {
      heading: "1. Acceptance & Eligibility",
      paragraphs: [
        'By accessing or using the AureonX platform ("Platform"), you agree to be bound by these Terms of Service. You must be at least 18 years old (or the legal age in your jurisdiction) and satisfy all Know Your Customer (KYC) and Anti-Money Laundering (AML) verification requirements.',
      ],
    },
    {
      heading: "2. Services Offered",
      paragraphs: [
        "AureonX provides software for multi-asset trading, order routing, and market data access across digital assets, stocks, and derivatives. AureonX does not guarantee execution prices, latency, or liquidity.",
      ],
    },
    {
      heading: "3. Account Responsibilities & Security",
      paragraphs: [
        "You are solely responsible for safeguarding your login credentials, API keys, and multi-factor authentication (MFA) devices.",
        "AureonX reserves the right to suspend or terminate accounts suspected of market manipulation, fraudulent activity, or security breaches.",
      ],
    },
    {
      heading: "4. Margins & Liquidation",
      paragraphs: [
        "For leveraged trading, position open/close parameters and liquidation thresholds are calculated algorithmically in real time. AureonX maintains the right to auto-liquidate under-margined positions without prior notice to protect system stability.",
      ],
    },
  ],
};
