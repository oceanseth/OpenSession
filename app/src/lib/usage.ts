/**
 * Token/cost aggregation over v0.5 `u` turn-usage records.
 *
 * Prices are estimates from the provider price cards (USD per million
 * tokens, standard tier, 2026-09). Models without a table entry still
 * aggregate tokens — they are just reported as unpriced rather than
 * guessed at.
 */
import type { MessageRecord, ParsedArchive, ParsedSession, TurnUsage } from './opensession';

export interface ModelPrice {
  /** USD per MTok: non-cached input, output, cache read, cache write. */
  in: number;
  out: number;
  cr: number;
  cw: number;
}

/** Longest-prefix match against the serving model id. */
const PRICES: [prefix: string, price: ModelPrice][] = [
  ['claude-fable-5', { in: 10, out: 50, cr: 0.25, cw: 12.5 }],
  ['claude-mythos-5', { in: 10, out: 50, cr: 0.25, cw: 12.5 }],
  ['claude-opus-5-5', { in: 4, out: 20, cr: 0.2, cw: 5 }],
  ['claude-opus-5', { in: 5, out: 25, cr: 0.5, cw: 6.25 }],
  ['claude-opus-4', { in: 5, out: 25, cr: 0.5, cw: 6.25 }],
  ['claude-sonnet-5', { in: 2, out: 10, cr: 0.2, cw: 2.5 }],
  ['claude-sonnet-4-6', { in: 3, out: 15, cr: 0.3, cw: 3.75 }],
  ['claude-haiku-4-5', { in: 1, out: 5, cr: 0.1, cw: 1.25 }],
];

export function priceFor(model?: string): ModelPrice | undefined {
  if (!model) return undefined;
  let best: ModelPrice | undefined;
  let bestLen = -1;
  for (const [prefix, price] of PRICES) {
    if (model.startsWith(prefix) && prefix.length > bestLen) {
      best = price;
      bestLen = prefix.length;
    }
  }
  return best;
}

/** Estimated cost of one turn in USD, or undefined when the model is unpriced. */
export function turnCost(u: TurnUsage): number | undefined {
  const p = priceFor(u.model);
  if (!p) return undefined;
  return ((u.in ?? 0) * p.in + (u.out ?? 0) * p.out + (u.cr ?? 0) * p.cr + (u.cw ?? 0) * p.cw) / 1e6;
}

export interface UsageTotals {
  in: number;
  out: number;
  cr: number;
  cw: number;
  ms: number;
  /** Estimated USD over priced turns only. */
  cost: number;
  /** Turns carrying a `u` record. */
  metered: number;
  /** Metered turns whose model has no price-table entry (cost under-counts these). */
  unpriced: number;
}

export function emptyTotals(): UsageTotals {
  return { in: 0, out: 0, cr: 0, cw: 0, ms: 0, cost: 0, metered: 0, unpriced: 0 };
}

export function addTurn(totals: UsageTotals, msg: MessageRecord): UsageTotals {
  const u = msg.u;
  if (!u) return totals;
  totals.in += u.in ?? 0;
  totals.out += u.out ?? 0;
  totals.cr += u.cr ?? 0;
  totals.cw += u.cw ?? 0;
  totals.ms += u.ms ?? 0;
  totals.metered += 1;
  const cost = turnCost(u);
  if (cost === undefined) totals.unpriced += 1;
  else totals.cost += cost;
  return totals;
}

export function sessionUsage(session: ParsedSession): UsageTotals {
  return session.messages.reduce(addTurn, emptyTotals());
}

export function archiveUsage(archive: ParsedArchive): UsageTotals {
  const totals = emptyTotals();
  for (const s of archive.sessions) for (const m of s.messages) addTurn(totals, m);
  return totals;
}

/** Total tokens through the context window: input + cache + output. */
export function totalTokens(t: { in: number; out: number; cr: number; cw: number }): number {
  return t.in + t.out + t.cr + t.cw;
}

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function fmtUsd(n: number): string {
  if (n >= 100) return `$${Math.round(n)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

export function fmtDuration(ms: number): string {
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

/** One-line summary for a usage total, e.g. "2.7M tok · $3.42 · 41m". */
export function usageSummary(t: UsageTotals): string | null {
  if (!t.metered) return null;
  const parts = [`${fmtTokens(totalTokens(t))} tok`];
  if (t.cost > 0) parts.push(t.unpriced ? `≥${fmtUsd(t.cost)}` : fmtUsd(t.cost));
  if (t.ms > 0) parts.push(fmtDuration(t.ms));
  return parts.join(' · ');
}

/** Compact per-turn badge, e.g. "1.2k out · 4.7s · $0.031". */
export function turnSummary(u: TurnUsage): string {
  const parts: string[] = [];
  if (u.out !== undefined) parts.push(`${fmtTokens(u.out)} out`);
  if (u.ms !== undefined) parts.push(fmtDuration(u.ms));
  const cost = turnCost(u);
  if (cost !== undefined && cost > 0) parts.push(fmtUsd(cost));
  return parts.join(' · ');
}

/** Tooltip breakdown for one turn's usage. */
export function turnDetail(u: TurnUsage): string {
  const lines: string[] = [];
  lines.push(`input ${fmtTokens(u.in ?? 0)} · output ${fmtTokens(u.out ?? 0)}`);
  lines.push(`cache read ${fmtTokens(u.cr ?? 0)} · cache write ${fmtTokens(u.cw ?? 0)}`);
  if (u.model) lines.push(`served by ${u.model}`);
  const cost = turnCost(u);
  if (cost !== undefined) lines.push(`est. ${fmtUsd(cost)}`);
  return lines.join('\n');
}

/** Tooltip breakdown for a usage total. */
export function usageDetail(t: UsageTotals): string {
  const lines = [
    `input ${fmtTokens(t.in)} · output ${fmtTokens(t.out)}`,
    `cache read ${fmtTokens(t.cr)} · cache write ${fmtTokens(t.cw)}`,
  ];
  if (t.cost > 0) {
    lines.push(
      `est. ${fmtUsd(t.cost)}${t.unpriced ? ` (+${t.unpriced} turn${t.unpriced > 1 ? 's' : ''} on unpriced models)` : ''}`,
    );
  }
  if (t.ms > 0) lines.push(`model time ${fmtDuration(t.ms)}`);
  return lines.join('\n');
}
