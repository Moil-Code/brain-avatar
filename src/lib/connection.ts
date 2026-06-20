import { useEffect, useRef, useState } from "react";
import { llmProbe } from "./tauri";
import type { Settings } from "./types";

/**
 * Connection health for the LM Studio endpoint (the 24GB Mac).
 *
 * The avatar talks to LM Studio request-by-request, so after the Mac sleeps,
 * reboots, or LM Studio restarts there is no socket to "drop" — the next send
 * just fails. This watcher closes that gap: it actively polls the endpoint and
 * flips the UI to "reconnecting" the moment the box goes away, then auto-recovers
 * (and refreshes the model list) the moment it comes back — so the user isn't
 * left staring at a dead avatar wondering whether to retry.
 */
export type ConnState = "online" | "offline" | "checking";

/** Cadence: relaxed while healthy, fast-then-backed-off while down so we notice
 *  a recovery within a couple of seconds without hammering a box that's booting. */
const ONLINE_INTERVAL = 15_000;
const OFFLINE_MIN = 2_000;
const OFFLINE_MAX = 20_000;

/**
 * One health check of the configured endpoints (remote 24GB Mac first, then a
 * local fallback if one is configured). Cheap and safe to run during a
 * generation: `llmProbe` hits the ungated `/models` path, so it never queues
 * behind an in-flight completion. Returns the reachable endpoint's loaded models
 * too, so the caller can keep the model picker current without a second probe.
 */
export async function pingEndpoints(
  settings: Settings
): Promise<{ ok: boolean; models: string[] }> {
  if (settings.lm_studio_remote_url) {
    const p = await llmProbe(settings.lm_studio_remote_url, settings.lm_studio_remote_token).catch(
      () => null
    );
    if (p?.ok) return { ok: true, models: p.models };
  }
  if (settings.lm_studio_local_url) {
    const p = await llmProbe(settings.lm_studio_local_url).catch(() => null);
    if (p?.ok) return { ok: true, models: p.models };
  }
  return { ok: false, models: [] };
}

/**
 * React hook that tracks endpoint reachability and calls `onRecover` on every
 * offline→online transition (so the caller can refresh the model picker). The
 * very first successful check (checking→online) does NOT fire `onRecover` — app
 * bootstrap already loads models — only a genuine recovery after a drop does.
 *
 * `onModels` (if given) fires on EVERY healthy poll with the endpoint's currently
 * loaded models, so a model loaded/unloaded in LM Studio while the app is running
 * shows up in the picker within one poll interval — no reconnect or restart needed.
 */
export function useConnection(
  settings: Settings | null,
  onRecover?: () => void,
  onModels?: (models: string[]) => void
): ConnState {
  const [state, setState] = useState<ConnState>("checking");
  const onRecoverRef = useRef(onRecover);
  onRecoverRef.current = onRecover;
  const onModelsRef = useRef(onModels);
  onModelsRef.current = onModels;
  const stateRef = useRef<ConnState>("checking");

  useEffect(() => {
    if (!settings) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let backoff = OFFLINE_MIN;

    const tick = async () => {
      const { ok, models } = await pingEndpoints(settings);
      if (cancelled) return;
      if (ok) onModelsRef.current?.(models);

      const prev = stateRef.current;
      const next: ConnState = ok ? "online" : "offline";
      if (next !== prev) {
        stateRef.current = next;
        setState(next);
        if (next === "online" && prev === "offline") onRecoverRef.current?.();
      }

      let delay: number;
      if (ok) {
        backoff = OFFLINE_MIN;
        delay = ONLINE_INTERVAL;
      } else {
        delay = backoff;
        backoff = Math.min(backoff * 2, OFFLINE_MAX);
      }
      timer = setTimeout(tick, delay);
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [settings]);

  return state;
}
