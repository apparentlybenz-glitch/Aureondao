// Support message field, checked in the browser before the RPC. The server
// (support_create_ticket, support_reply) applies the same rule.
export const BODY_MAX = 2000;

export function bodyOk(body: string): boolean {
  const n = body.trim().length;
  return n >= 1 && n <= BODY_MAX;
}
