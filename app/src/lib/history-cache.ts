/**
 * Delta-fetching cache for llm-turn-history.jsonl files.
 *
 * The history file is append-only by license, so once we've fetched it we
 * only need the bytes past our cached length: an HTTP Range request against
 * raw.githubusercontent.com, with a byte-overlap check to detect rewrites
 * (which fall back to a full fetch). All arithmetic is in bytes, not JS
 * string length — histories contain multibyte text.
 */
import type { GitHubClient } from './github';
import { HISTORY_FILE } from './github';

export interface CachedHistory {
  sha: string;
  text: string;
  byteLength: number;
}

/** Bytes of already-cached tail re-requested to verify the file only grew. */
const OVERLAP = 64;
const STORE_PREFIX = 'opensession.history.';
const MAX_STORED_BYTES = 512 * 1024; // per repo; larger files just refetch deltas in-session

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toCached(text: string, sha: string): CachedHistory {
  return { sha, text, byteLength: encoder.encode(text).length };
}

/**
 * Merge a ranged chunk (starting at byte `start` of the file) onto the cached
 * text. Returns the combined text, or null if the overlap doesn't match the
 * cache (file was rewritten — caller should full-fetch).
 */
export function mergeDelta(cached: CachedHistory, chunkBytes: Uint8Array, start: number): string | null {
  const cachedBytes = encoder.encode(cached.text);
  if (start > cachedBytes.length) return null;
  const expectedOverlap = cachedBytes.subarray(start);
  if (chunkBytes.length < expectedOverlap.length) return null;
  for (let i = 0; i < expectedOverlap.length; i++) {
    if (chunkBytes[i] !== expectedOverlap[i]) return null;
  }
  const combined = new Uint8Array(start + chunkBytes.length);
  combined.set(cachedBytes.subarray(0, start), 0);
  combined.set(chunkBytes, start);
  return decoder.decode(combined);
}

export interface FetchResult {
  cached: CachedHistory;
  /** True when only the appended tail was transferred. */
  delta: boolean;
}

/**
 * Fetch a repo's history, transferring only appended bytes when possible.
 * `probe` is the current blob {sha, size} (true byte size) from the GitHub
 * contents API.
 */
export async function fetchHistory(
  client: GitHubClient,
  fullName: string,
  probe: { sha: string; size: number },
  cached: CachedHistory | null,
): Promise<FetchResult> {
  if (cached && cached.sha === probe.sha) return { cached, delta: true };

  if (cached && probe.size > cached.byteLength) {
    const start = Math.max(0, cached.byteLength - OVERLAP);
    const res = await fetch(
      `https://raw.githubusercontent.com/${fullName}/HEAD/${HISTORY_FILE}`,
      { headers: { Range: `bytes=${start}-` } },
    );
    if (res.status === 206) {
      const chunkBytes = new Uint8Array(await res.arrayBuffer());
      const merged = mergeDelta(cached, chunkBytes, start);
      // Only trust the merge if it reproduces the probed size exactly —
      // raw's CDN can briefly serve a stale tail after an append.
      if (merged !== null && start + chunkBytes.length === probe.size) {
        return { cached: toCached(merged, probe.sha), delta: true };
      }
    }
  }

  const text = await client.fetchHistoryFile(fullName);
  const full = toCached(text, probe.sha);
  // If the CDN served a stale full copy, poison the sha so the next open refetches.
  if (full.byteLength !== probe.size) full.sha = `stale-${probe.sha}`;
  return { cached: full, delta: false };
}

export function loadCache(fullName: string): CachedHistory | null {
  try {
    const raw = localStorage.getItem(STORE_PREFIX + fullName);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { sha: string; text: string };
    return toCached(parsed.text, parsed.sha);
  } catch {
    return null;
  }
}

export function saveCache(fullName: string, cached: CachedHistory): void {
  if (cached.byteLength > MAX_STORED_BYTES) return;
  try {
    localStorage.setItem(STORE_PREFIX + fullName, JSON.stringify({ sha: cached.sha, text: cached.text }));
  } catch {
    /* quota exceeded — in-memory cache still works this session */
  }
}
