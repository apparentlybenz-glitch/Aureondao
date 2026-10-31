// "jane.doe@example.com" -> "ja****oe@example.com": the first two characters, ****,
// then the last two before the @. A local part of 4 characters or fewer keeps only
// its first two, so no character is shown twice.
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return email;
  const local = email.slice(0, at);
  const tail = local.length > 4 ? local.slice(-2) : "";
  return `${local.slice(0, 2)}****${tail}${email.slice(at)}`;
}
