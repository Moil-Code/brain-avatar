import type { VercelRequest, VercelResponse } from "@vercel/node";
import { authorized, supabase } from "../lib/supabase.js";

/**
 * /api/feedback
 *   POST  { conversationId, messageId, rating: -1|1 }  -> record quality signal
 *
 * Upserts on messageId so a user can change their rating. The nightly enrichment
 * automation can use these signals to focus on conversations with poor ratings.
 *
 * Auth: Authorization: Bearer <SYNC_TOKEN>
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req.headers.authorization)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }

  try {
    const { conversationId, messageId, rating } = req.body ?? {};

    if (!conversationId || typeof conversationId !== "string" || !conversationId.trim()) {
      return res.status(400).json({ error: "conversationId required" });
    }
    if (!messageId || typeof messageId !== "string" || !messageId.trim()) {
      return res.status(400).json({ error: "messageId required" });
    }
    const r = Number(rating);
    if (r !== -1 && r !== 1) {
      return res.status(400).json({ error: "rating must be -1 or 1" });
    }

    const db = supabase();
    const { error } = await db
      .from("message_feedback")
      .upsert(
        { conversation_id: conversationId, message_id: messageId, rating: r },
        { onConflict: "message_id" }
      );

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
