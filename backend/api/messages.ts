import type { VercelRequest, VercelResponse } from "@vercel/node";
import { authorized, supabase } from "../lib/supabase.js";

/**
 * /api/messages
 *   POST  { conversationId, role, content }   -> persist a turn
 *   GET   ?conversationId=..&limit=..         -> recent turns (ascending)
 *
 * Auth: Authorization: Bearer <SYNC_TOKEN>
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req.headers.authorization)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const db = supabase();

    if (req.method === "POST") {
      const { conversationId, role, content } = req.body ?? {};
      if (!conversationId || !role || typeof content !== "string") {
        return res.status(400).json({ error: "conversationId, role, content required" });
      }
      const { error } = await db.from("messages").insert({
        conversation_id: String(conversationId),
        role: String(role),
        content,
      });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json({ ok: true });
    }

    if (req.method === "GET") {
      const conversationId = String(req.query.conversationId ?? "");
      const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
      if (!conversationId) {
        return res.status(400).json({ error: "conversationId required" });
      }
      const { data, error } = await db
        .from("messages")
        .select("role, content, created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data ?? []);
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
