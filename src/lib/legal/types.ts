export type LegalSection = {
  heading: string;
  paragraphs: string[];
};

export type LegalContent = {
  version: string;
  effectiveDate: string;
  subtitle?: string;
  sections: LegalSection[];
};
