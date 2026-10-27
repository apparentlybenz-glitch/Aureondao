// Escapes the LIKE wildcards (% and _) and the escape character itself, so a
// search term matches literally inside an ilike pattern.
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
