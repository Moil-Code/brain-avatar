import type { VercelRequest, VercelResponse } from "@vercel/node";
import { authorized, supabase } from "../lib/supabase.js";

/**
 * /api/digest
 *   GET  ?date=YYYY-MM-DD  -> all conversations from that date with their messages
 *
 * Used by the nightly brain enrichment automation: the desktop app calls this,
 * hands the transcripts to the LLM, and pushes extracted insights into gbrain.
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
    const db = supabase();

    const today = new Date().toISOString().slice(0, 10);
    const dateParam = String(req.query.date ?? "").trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : today;

    const startTs = `${date}T00:00:00Z`;
    const endTs = `${date}T23:59:59Z`;

    const { data, error } = await db
      .from("messages")
      .select("conversation_id, role, content, created_at")
      .gte("created_at", startTs)
      .lte("created_at", endTs)
      .order("conversation_id", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(10000); // server-side cap; we trim further below

    if (error) return res.status(500).json({ error: error.message });

    // Group by conversation_id; cap at 50 conversations and 200 messages each.
    const MAX_CONVS = 50;
    const MAX_MSGS_PER_CONV = 200;

    const convMap = new Map<string, { role: string; content: string; created_at: string }[]>();
    for (const row of data ?? []) {
      const id = row.conversation_id as string;
      if (!convMap.has(id)) {
        if (convMap.size >= MAX_CONVS) continue;
        convMap.set(id, []);
      }
      const msgs = convMap.get(id)!;
      if (msgs.length < MAX_MSGS_PER_CONV) {
        msgs.push({
          role: row.role as string,
          content: row.content as string,
          created_at: row.created_at as string,
        });
      }
    }

    const conversations = Array.from(convMap.entries()).map(([conversation_id, messages]) => ({
      conversation_id,
      messages,
    }));

    return res.status(200).json({ date, conversations });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
