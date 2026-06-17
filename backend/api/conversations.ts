import type { VercelRequest, VercelResponse } from "@vercel/node";
import { authorized, supabase } from "../lib/supabase.js";

/**
 * /api/conversations
 *   GET  ?limit=..   -> conversation summaries (newest first)
 *
 * The missing piece for true cross-device history: lets a client discover
 * conversations started on OTHER devices (each summary derived from the
 * `messages` table via the `conversation_summaries` view). Pair with
 * GET /api/messages?conversationId=.. to hydrate a conversation's turns.
 *
 * Auth: Authorization: Bearer <SYNC_TOKEN>
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req.headers.authorization)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "method not allowed" });
  }

  try {
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 500);
    const { data, error } = await supabase()
      .from("conversation_summaries")
      .select("conversation_id, title, created_at, updated_at, message_count")
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data ?? []);
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
