/**
 * Unseen-turn tracking: remembers how many turns of each session the user
 * has viewed (keyed by repo + session sid/index) so the sidebar can badge
 * what's new when live polling pulls fresh turns.
 */

const KEY = 'opensession.desktop.seen-turns';

type SeenMap = Record<string, number>;

function load(): SeenMap {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as SeenMap;
  } catch {
    return {};
  }
}

export function sessionKey(repo: string, sid: string | undefined, index: number): string {
  return `${repo}#${sid ?? `i${index}`}`;
}

export function seenCount(key: string): number {
  return load()[key] ?? 0;
}

export function markSeen(key: string, count: number): void {
  const map = load();
  if ((map[key] ?? 0) >= count) return;
  map[key] = count;
  localStorage.setItem(KEY, JSON.stringify(map));
}
