// Support ticket fields, checked in the browser before the RPC. The server
// (support_create_ticket, support_reply) applies the same rules.
export const SUPPORT_TOPICS = ["account", "balance_funding", "trading", "verification", "security", "other"] as const;
export type SupportTopic = (typeof SUPPORT_TOPICS)[number];
export const SUBJECT_MAX = 120;
export const BODY_MAX = 2000;

export function isTopic(value: string): value is SupportTopic {
  return (SUPPORT_TOPICS as readonly string[]).includes(value);
}

export function subjectOk(subject: string): boolean {
  const n = subject.trim().length;
  return n >= 1 && n <= SUBJECT_MAX;
}

export function bodyOk(body: string): boolean {
  const n = body.trim().length;
  return n >= 1 && n <= BODY_MAX;
}

export function ticketOk(topic: string, subject: string, body: string): boolean {
  return isTopic(topic) && subjectOk(subject) && bodyOk(body);
}
