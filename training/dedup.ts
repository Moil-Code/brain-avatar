// Corpus de-duplication for the exporter.
//
// Training small models repeatedly on identical or near-identical examples wastes
// capacity and amplifies model-collapse risk (recursive/duplicated synthetic data
// degrades the output distribution — Shumailov et al., Nature 2024; SemDeDup, Abbas
// et al., 2023). Our synthetic generator multiplies over entity pools and phrasings,
// and live capture will accrue repeats, so the corpus needs a dedup pass before it
// becomes a training set.
//
// This is a DETERMINISTIC, offline, embedding-free approximation of SemDeDup:
//   - exact: drop records whose normalized signature already appeared
//   - near:  also drop records whose 3-shingle Jaccard vs. an already-kept record
//            meets a threshold (default 0.9)
// First occurrence wins, so the kept set is stable and order-independent enough for
// our deterministic split. (No model, no network — keeps the exporter offline.)

export type DedupMode = "off" | "exact" | "near";

function normalizeText(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A record's dedup signature: the user ask + the ORDERED tool-name sequence + the
 *  final answer, normalized. Captures "same request → same tool plan → same answer"
 *  while ignoring punctuation/casing/whitespace noise. */
export function recordSignature(user: string, toolSequence: string[], finalAnswer: string): string {
  return normalizeText(`${user} || ${toolSequence.join(",")} || ${finalAnswer}`);
}

function shingles(s: string, k = 3): Set<string> {
  const toks = normalizeText(s).split(" ").filter(Boolean);
  const out = new Set<string>();
  if (toks.length < k) {
    if (toks.length) out.add(toks.join(" "));
    return out;
  }
  for (let i = 0; i + k <= toks.length; i++) out.add(toks.slice(i, i + k).join(" "));
  return out;
}

/** Jaccard similarity of two shingle sets (1 when both empty). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface DedupResult<T> {
  kept: T[];
  removed: number;
}

/** Drop exact (and optionally near) duplicates by signature, first occurrence wins. */
export function dedup<T>(
  items: T[],
  sigOf: (t: T) => string,
  mode: DedupMode,
  threshold = 0.9
): DedupResult<T> {
  if (mode === "off") return { kept: items, removed: 0 };
  const kept: T[] = [];
  const seenExact = new Set<string>();
  const keptShingles: Set<string>[] = [];
  let removed = 0;
  for (const it of items) {
    const sig = sigOf(it);
    if (seenExact.has(sig)) {
      removed++;
      continue;
    }
    if (mode === "near") {
      const sh = shingles(sig);
      if (keptShingles.some((ks) => jaccard(sh, ks) >= threshold)) {
        removed++;
        continue;
      }
      keptShingles.push(sh);
    }
    seenExact.add(sig);
    kept.push(it);
  }
  return { kept, removed };
}
