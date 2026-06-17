import { timingSafeEqual } from "node:crypto";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/** Server-side Supabase client using the service-role key (bypasses RLS). */
export function supabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

/** Constant-time bearer check against SYNC_TOKEN. This endpoint is public on the
 *  internet, so the compare must not leak the token via early-exit timing. */
export function authorized(authHeader: string | undefined): boolean {
  const expected = process.env.SYNC_TOKEN;
  if (!expected) return false;
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice("Bearer ".length).trim();
  if (token.length === 0) return false;
  const enc = new TextEncoder();
  const a = enc.encode(token);
  const b = enc.encode(expected);
  // timingSafeEqual requires equal-length buffers; a length mismatch is already a
  // non-match (token length isn't the secret), so short-circuit before comparing.
  return a.length === b.length && timingSafeEqual(a, b);
}
