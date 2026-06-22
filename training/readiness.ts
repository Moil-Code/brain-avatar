// Standalone training-readiness gate — the CLI twin of the in-app check
// (src-tauri/src/trajectory.rs::training_readiness). Counts LIVE (and rated-live)
// trajectories captured SINCE the most recent training run and decides whether a
// run is worthwhile. Exits 0 when ready, 1 when not — so a wrapper/cron job can
// branch on `if node readiness.ts; then …`. No model, no network, no app needed.
//
// Run:  node --experimental-strip-types training/readiness.ts [--live DIR] [--json]

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TrajectoryRecord } from "./types.ts";

// Keep these in lockstep with READY_NEW_LIVE / READY_NEW_RATED in trajectory.rs.
const READY_NEW_LIVE = 50;
const READY_NEW_RATED = 15;

const APP_DIR = join(homedir(), "Library", "Application Support", "com.moil.brainavatar");

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const liveDir = arg("live", join(APP_DIR, "trajectories"));
const runsLog = arg("runs", join(APP_DIR, "training-runs.jsonl"));
const asJson = process.argv.includes("--json");

function loadJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return []; // skip a malformed line rather than fail the whole gate
      }
    });
}

function loadLive(dir: string): TrajectoryRecord[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => loadJsonl<TrajectoryRecord>(join(dir, f)));
}

// High-water mark: the started_at of the most recent run (ISO sorts lexically).
const runs = loadJsonl<{ started_at?: string }>(runsLog);
const lastTrained = runs
  .map((r) => r.started_at ?? "")
  .filter(Boolean)
  .sort()
  .at(-1) ?? null;

let newLive = 0;
let newRated = 0;
for (const r of loadLive(liveDir)) {
  const isLive = !r.source || r.source === "live";
  if (!isLive) continue;
  if (lastTrained && r.created_at <= lastTrained) continue; // only count since last run
  newLive++;
  if (r.rating != null) newRated++;
}

const ready = newLive >= READY_NEW_LIVE || newRated >= READY_NEW_RATED;
const summary = {
  ready,
  new_live: newLive,
  new_rated: newRated,
  live_threshold: READY_NEW_LIVE,
  rated_threshold: READY_NEW_RATED,
  last_trained: lastTrained,
};

if (asJson) {
  console.log(JSON.stringify(summary));
} else if (ready) {
  console.error(`READY: ${newLive} new turns (${newRated} rated) since ${lastTrained ?? "the start"}.`);
} else {
  const needLive = Math.max(0, READY_NEW_LIVE - newLive);
  console.error(
    `not ready: ${newLive}/${READY_NEW_LIVE} new turns (${newRated}/${READY_NEW_RATED} rated) since ${lastTrained ?? "the start"} — ${needLive} more to go.`
  );
}

process.exit(ready ? 0 : 1);
