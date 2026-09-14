import { windowFor } from "./models.js";
import { fmt } from "./types.js";
import type { Rule } from "./types.js";

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** Fewer turns than this and a projection means nothing; an agent reading files grows fast at first. */
const MIN_TURNS = 6;
const DEFAULT_LIMIT = 10;

export const growth: Rule = {
  id: "growth",
  title: "The context grows every turn and never shrinks",
  description: `Over ${MIN_TURNS}+ turns, input grows by more than --max-growth percent per turn (default ${DEFAULT_LIMIT}; the median, so a warm-up call does not distort it) and never shrinks; projects the turn at which the window fills.`,
  defaultSeverity: "warn",
  check(turns, options) {
    if (turns.length < MIN_TURNS) return [];
    const totals = turns.map((t) => t.context.totalTokens);
    let shrank = false;
    const rates: number[] = [];
    for (let i = 1; i < totals.length; i++) {
      const prev = totals[i - 1]!;
      const cur = totals[i]!;
      if (cur < prev) shrank = true;
      if (prev > 0) rates.push((cur - prev) / prev);
    }
    if (shrank || !rates.length) return [];
    // The median, not the mean: an agent's first call is often a tiny warm-up,
    // and the jump from it to the real first turn is not "growth".
    const rate = median(rates) * 100;
    const limit = options.maxGrowthPct ?? DEFAULT_LIMIT;
    if (rate < limit) return [];
    const last = turns[turns.length - 1]!;
    const win = options.window
      ? { tokens: options.window, assumed: false }
      : windowFor(last.context.model);
    let projected = totals[totals.length - 1]!;
    let turn = turns.length;
    while (projected < win.tokens && turn < 10_000) {
      projected *= 1 + rate / 100;
      turn++;
    }
    return [
      {
        rule: growth.id,
        severity: "warn",
        tokens: totals[totals.length - 1]! - totals[0]!,
        message: `context grew ${rate.toFixed(0)}% per turn (median) over ${turns.length} turns and never shrank — at this rate the ${fmt(win.tokens)} window${win.assumed ? " (assumed; set --window)" : ""} fills at turn ${turn}`,
        detail: [`${fmt(totals[0]!)} → ${fmt(totals[totals.length - 1]!)} input tokens`],
      },
    ];
  },
};
