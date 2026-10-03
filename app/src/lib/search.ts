/**
 * Session search: full-text search over parsed open-session archives,
 * shared by the web app and the desktop app ("grep the intent, not the
 * code"). Pure functions over ParsedArchive — no fetching here; each
 * surface feeds it whatever archives it has.
 */
import { sessionLabel, speakerOf, type ParsedArchive } from './opensession';

export interface SearchHit {
  repo: string;
  sessionIndex: number;
  sessionLabel: string;
  sid?: string;
  turnId: string;
  ts?: string;
  speakerName: string;
  speakerKind: 'human' | 'model' | 'unknown';
  /** Context window around the first match. */
  excerpt: string;
  score: number;
}

/** Lowercased AND-terms from a query ("" → none). */
export function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

const EXCERPT_RADIUS = 90;

function excerptAround(text: string, index: number, matchLen: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(text.length, index + matchLen + EXCERPT_RADIUS);
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${oneLine(text.slice(start, end))}${end < text.length ? '…' : ''}`;
}

/**
 * Search one archive. Every term must appear in a turn's text
 * (case-insensitive) for the turn to hit; score favors term frequency and
 * recency so active work surfaces first.
 */
export function searchArchive(repo: string, archive: ParsedArchive, terms: string[]): SearchHit[] {
  if (!terms.length) return [];
  const hits: SearchHit[] = [];
  archive.sessions.forEach((session, sessionIndex) => {
    for (const msg of session.messages) {
      const lower = msg.t.toLowerCase();
      let firstIndex = -1;
      let freq = 0;
      let allMatch = true;
      for (const term of terms) {
        const i = lower.indexOf(term);
        if (i === -1) {
          allMatch = false;
          break;
        }
        if (firstIndex === -1 || i < firstIndex) firstIndex = i;
        // term frequency, cheap count
        let n = 0;
        for (let at = i; at !== -1; at = lower.indexOf(term, at + term.length)) n++;
        freq += n;
      }
      if (!allMatch) continue;
      const speaker = speakerOf(session, msg);
      const tsMs = msg.ts ? Date.parse(msg.ts) : NaN;
      // Recency: scale into [0, 2] over roughly the last year.
      const ageDays = Number.isFinite(tsMs) ? (Date.now() - tsMs) / 86_400_000 : 365;
      const recency = Math.max(0, 2 - ageDays / 180);
      hits.push({
        repo,
        sessionIndex,
        sessionLabel: sessionLabel(session, sessionIndex),
        sid: session.session.sid,
        turnId: msg.id,
        ts: msg.ts,
        speakerName: speaker?.name ?? msg.m,
        speakerKind: speaker?.kind ?? 'unknown',
        excerpt: excerptAround(msg.t, firstIndex, terms[0].length),
        score: freq + recency,
      });
    }
  });
  return hits;
}

export function searchArchives(
  entries: { repo: string; archive: ParsedArchive }[],
  query: string,
  limit = 50,
): SearchHit[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const all: SearchHit[] = [];
  for (const { repo, archive } of entries) all.push(...searchArchive(repo, archive, terms));
  all.sort((a, b) => b.score - a.score || (b.ts ?? '').localeCompare(a.ts ?? ''));
  return all.slice(0, limit);
}

/** Split an excerpt into plain/match segments for <mark> highlighting. */
export function excerptSegments(excerpt: string, terms: string[]): { text: string; match: boolean }[] {
  if (!terms.length) return [{ text: excerpt, match: false }];
  const lower = excerpt.toLowerCase();
  const bounds: [number, number][] = [];
  for (const term of terms) {
    for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + term.length)) {
      bounds.push([at, at + term.length]);
    }
  }
  bounds.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const segments: { text: string; match: boolean }[] = [];
  let pos = 0;
  for (const [start, end] of bounds) {
    if (end <= pos) continue;
    const from = Math.max(start, pos);
    if (from > pos) segments.push({ text: excerpt.slice(pos, from), match: false });
    segments.push({ text: excerpt.slice(from, end), match: true });
    pos = end;
  }
  if (pos < excerpt.length) segments.push({ text: excerpt.slice(pos), match: false });
  return segments;
}
