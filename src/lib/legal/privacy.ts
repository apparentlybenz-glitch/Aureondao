import type { LegalContent } from "./types";

export const privacy: LegalContent = {
  version: "1.0",
  effectiveDate: "October 2026",
  sections: [
    {
      heading: "1. Data Collection",
      paragraphs: [
        "We collect personal information necessary to deliver our services, satisfy regulatory compliance, and ensure platform security:",
        "Identity Data: Full name, date of birth, government identification numbers, and residential proof.",
        "Financial Data: Wallet addresses, bank account details, and transaction history.",
        "Technical Data: IP address, device fingerprints, login logs, and operational telemetry.",
      ],
    },
    {
      heading: "2. Use of Information",
      paragraphs: [
        "Your data is used strictly to:",
        "Verify identity and fulfill KYC/AML obligations.",
        "Process transactions and manage order routing.",
        "Detect and prevent fraud, cyber attacks, and illegal market practices.",
      ],
    },
    {
      heading: "3. Third-Party Sharing & Transfers",
      paragraphs: [
        "We do not sell personal data. Information may be shared with regulatory bodies, liquidity partners, and risk intelligence services solely for compliance and trade execution purposes under strict confidentiality agreements.",
      ],
    },
  ],
};
