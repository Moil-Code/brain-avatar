// KTO preference-tuning helpers.
//
// KTO (Kahneman–Tversky Optimization) is the right algorithm for our UNPAIRED binary
// thumbs 👍/👎 (DPO needs matched chosen/rejected pairs we don't have). But raw KTO on
// imbalanced thumbs is fragile:
//   1. Class imbalance — thumbs-up vastly outnumber thumbs-down. TRL's guidance is to
//      weight the classes so (desirable_weight·n_pos) : (undesirable_weight·n_neg) lands
//      in the 1:1 … 4:3 band (https://huggingface.co/docs/trl/main/en/kto_trainer).
//   2. Sycophancy / over-optimization — optimizing toward thumbs-up can reward
//      agreeable-but-wrong answers (Sharma et al. 2023, https://arxiv.org/abs/2310.13548;
//      direct-alignment over-optimization, https://arxiv.org/abs/2406.02900).
//
// We can't run the trainer here, but we CAN compute the balancing weights deterministically
// from the exported set and emit them (+ a guardrail note) for the Mac-side run. "I script,
// you run."

export interface KtoWeights {
  n_pos: number;
  n_neg: number;
  /** Multiplier for desirable (👍) examples. */
  desirable_weight: number;
  /** Multiplier for undesirable (👎) examples. */
  undesirable_weight: number;
  /** Resulting weighted desirable:undesirable ratio (target ≈ 1.0, band 1.0–1.333). */
  ratio: number;
  note?: string;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Balance KTO classes by up-weighting the minority (keeping the majority at 1.0) so the
 * weighted ratio hits `target` (default 1.0 — the floor of TRL's 1.0–1.333 band).
 */
export function ktoWeights(nPos: number, nNeg: number, target = 1.0): KtoWeights {
  if (nPos === 0 || nNeg === 0) {
    return {
      n_pos: nPos,
      n_neg: nNeg,
      desirable_weight: 1,
      undesirable_weight: 1,
      ratio: nPos === nNeg ? 1 : nPos > 0 ? Infinity : 0,
      note: "only one preference class present — cannot balance; collect both 👍 and 👎 before KTO",
    };
  }
  let desirable_weight = 1;
  let undesirable_weight = 1;
  if (nPos >= nNeg) {
    undesirable_weight = nPos / (target * nNeg); // up-weight the rarer 👎
  } else {
    desirable_weight = (target * nNeg) / nPos; // up-weight the rarer 👍
  }
  const ratio = (desirable_weight * nPos) / (undesirable_weight * nNeg);
  return {
    n_pos: nPos,
    n_neg: nNeg,
    desirable_weight: round2(desirable_weight),
    undesirable_weight: round2(undesirable_weight),
    ratio: round2(ratio),
  };
}

/** The guardrail every KTO run should carry (written into kto_config.json). */
export const KTO_GUARD =
  "Guardrails: weight explicit tool-success outcomes above raw thumbs; keep an SFT " +
  "anchor (don't KTO from scratch); a turn the user thumbed up that narrated instead of " +
  "acting must not be rewarded; watch for over-optimization/sycophancy and early-stop on " +
  "held-out tool-call success + grounding, not on the thumbs signal.";
