import { createClient } from "@/lib/supabase/client";
import type { SupportTopic } from "@/lib/support-rules";

export const SUPPORT_STATUSES = ["open", "answered", "closed"] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

export type SupportTicket = {
  id: string;
  user_id: string;
  topic: SupportTopic;
  subject: string;
  status: SupportStatus;
  created_at: string;
  updated_at: string;
};
// author_id is not granted to authenticated: no client learns which admin replied.
export type SupportMessage = { id: string; is_staff: boolean; body: string; created_at: string };

export const TICKET_SELECT = "id, user_id, topic, subject, status, created_at, updated_at";
const MESSAGE_SELECT = "id, is_staff, body, created_at";
export const TICKETS_LIMIT = 100;

// Reads go through RLS: a user sees own tickets, an admin every ticket, so the
// user list filters by the own id. Every read returns null when it failed.
export async function fetchOwnTickets(): Promise<SupportTicket[] | null> {
  const supabase = createClient();
  const { data: session } = await supabase.auth.getSession();
  const userId = session.session?.user.id;
  if (!userId) return null;
  const { data, error } = await supabase
    .from("support_tickets")
    .select(TICKET_SELECT)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(TICKETS_LIMIT)
    .overrideTypes<SupportTicket[], { merge: false }>();
  return error ? null : data;
}

export async function fetchMessages(ticketId: string): Promise<SupportMessage[] | null> {
  const { data, error } = await createClient()
    .from("support_messages")
    .select(MESSAGE_SELECT)
    .eq("ticket_id", ticketId)
    .order("created_at")
    .order("id")
    .overrideTypes<SupportMessage[], { merge: false }>();
  return error ? null : data;
}

// The ticket after a reply, as support_reply leaves it: a staff reply answers it,
// a user reply opens it again.
export function afterReply(ticket: SupportTicket, message: SupportMessage): SupportTicket {
  return { ...ticket, status: message.is_staff ? "answered" : "open", updated_at: message.created_at };
}
