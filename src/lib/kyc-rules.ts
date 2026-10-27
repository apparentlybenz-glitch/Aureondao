// Browser-side KYC checks, mirroring the bucket limits and submit_kyc. The server
// checks everything again; these only stop a bad upload or submit early.

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const PHOTO_EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;
export type PhotoType = keyof typeof PHOTO_EXTENSIONS;
export const PHOTO_ACCEPT = Object.keys(PHOTO_EXTENSIONS).join(",");

export function isPhotoType(type: string): type is PhotoType {
  return Object.hasOwn(PHOTO_EXTENSIONS, type);
}

export function photoProblem(file: { type: string; size: number }): "type" | "size" | null {
  if (!isPhotoType(file.type)) return "type";
  if (file.size > MAX_PHOTO_BYTES) return "size";
  return null;
}

// The latest date of birth that is at least 18 years before `today` (UTC), as YYYY-MM-DD.
export function latestBirthDate(today: Date): string {
  const y = today.getUTCFullYear() - 18;
  const m = today.getUTCMonth();
  // Feb 29 has no match 18 years back; Date rolls it to Mar 1, so take the day before.
  const d = new Date(Date.UTC(y, m, today.getUTCDate()));
  if (d.getUTCMonth() !== m) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

// After 1900-01-01 and at least 18 years ago. ISO dates compare as strings.
export function birthDateOk(dob: string, today: Date): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(dob) && dob > "1900-01-01" && dob <= latestBirthDate(today);
}

export const nameOk = (name: string) => name.trim().length >= 2 && name.trim().length <= 100;
export const cityOk = (city: string) => city.trim().length >= 1 && city.trim().length <= 80;
