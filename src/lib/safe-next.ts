// Only same-origin paths are allowed as a post-auth redirect target.
// Rejects absolute URLs and protocol-relative "//host" or "/\host" forms.
export function safeNext(next: string | null | undefined, fallback = "/home"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return fallback;
  }
  return next;
}
