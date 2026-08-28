import { SCORE_WEIGHTS } from "./score";
import type { ScoreBreakdown, ScoredTarget } from "./types";

/**
 * HOW MUCH DOES THE RANKING DEPEND ON WEIGHTS I MADE UP?
 * ======================================================
 * The actionability weights in `score.ts` are considered judgements, but they
 * are still judgements. No ranger validated them and no outcome data supports
 * them. Presenting a single ranking derived from them, to one decimal place,
 * implies a precision that does not exist.
 *
 * So we test them. Perturb every weight repeatedly, re-rank, and record how
 * often each target survives in the top N. A target that stays top-ranked under
 * almost any plausible weighting is a genuinely robust recommendation. One that
 * only leads under my exact numbers is an artefact of my assumptions, and a
 * ranger deserves to be told which is which.
 *
 * This is cheap because it reuses the factor breakdown already computed for
 * each target — no re-routing, no re-clustering, just the weighted mean again.
 */

const KEYS = Object.keys(SCORE_WEIGHTS) as (keyof ScoreBreakdown)[];

/** How far each weight may move, as a fraction of itself. */
const JITTER = 0.5;

const TRIALS = 400;

export interface Robustness {
  /** Fraction of perturbed weightings in which this target stayed in the top N. */
  topNShare: number;
  /** Best and worst rank observed across all trials. */
  bestRank: number;
  worstRank: number;
  /** Rank under the shipped weights. */
  nominalRank: number;
}

function scoreWith(
  breakdown: ScoreBreakdown,
  weights: Record<keyof ScoreBreakdown, number>
): number {
  let logSum = 0;
  for (const k of KEYS) logSum += weights[k] * Math.log(Math.max(0.02, breakdown[k]));
  return Math.exp(logSum);
}

/**
 * Deterministic PRNG so the reported robustness figures are reproducible.
 * A number that changes on every page load is not evidence of anything.
 */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function analyseRobustness(
  targets: ScoredTarget[],
  topN = 5,
  seed = 12345
): Map<string, Robustness> {
  const rand = mulberry32(seed);

  const nominalRank = new Map<string, number>();
  targets.forEach((t, i) => nominalRank.set(t.id, i + 1));

  const inTopN = new Map<string, number>();
  const best = new Map<string, number>();
  const worst = new Map<string, number>();

  for (let trial = 0; trial < TRIALS; trial++) {
    // Jitter each weight multiplicatively, then renormalise so the weights
    // still sum to one and the scores stay comparable.
    const w = {} as Record<keyof ScoreBreakdown, number>;
    let total = 0;
    for (const k of KEYS) {
      const factor = 1 + (rand() * 2 - 1) * JITTER;
      w[k] = SCORE_WEIGHTS[k] * factor;
      total += w[k];
    }
    for (const k of KEYS) w[k] /= total;

    const ranked = [...targets]
      .map((t) => ({ id: t.id, s: scoreWith(t.breakdown, w) }))
      .sort((a, b) => b.s - a.s);

    ranked.forEach((r, i) => {
      const rank = i + 1;
      if (rank <= topN) inTopN.set(r.id, (inTopN.get(r.id) ?? 0) + 1);
      best.set(r.id, Math.min(best.get(r.id) ?? Infinity, rank));
      worst.set(r.id, Math.max(worst.get(r.id) ?? 0, rank));
    });
  }

  const out = new Map<string, Robustness>();
  for (const t of targets) {
    out.set(t.id, {
      topNShare: (inTopN.get(t.id) ?? 0) / TRIALS,
      bestRank: best.get(t.id) ?? nominalRank.get(t.id)!,
      worstRank: worst.get(t.id) ?? nominalRank.get(t.id)!,
      nominalRank: nominalRank.get(t.id)!,
    });
  }
  return out;
}
