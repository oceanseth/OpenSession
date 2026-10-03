import { useEffect, useMemo, useRef, useState } from 'react';
import type { GitHubClient } from '../lib/github';
import { fetchHistory, loadCache, saveCache } from '../lib/history-cache';
import { parseOpenSessionJsonl, type ParsedArchive } from '../lib/opensession';
import { excerptSegments, queryTerms, searchArchives, type SearchHit } from '../lib/search';

export interface SearchFocus {
  sessionIndex: number;
  turnId: string;
}

interface IndexEntry {
  text: string;
  archive: ParsedArchive;
}

/**
 * Session search: full-text search over the turn text of every searchable
 * repo (followed + discovered). Histories are fetched lazily on the first
 * query through the same delta-cache the feed uses, then searched locally.
 */
export function SessionSearch({
  client,
  repos,
  onOpen,
}: {
  client: GitHubClient;
  repos: { full_name: string }[];
  onOpen: (title: string, text: string, sourceUrl: string | undefined, focus: SearchFocus) => void;
}) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [indexedTick, setIndexedTick] = useState(0);
  const [indexing, setIndexing] = useState(false);
  const index = useRef(new Map<string, IndexEntry | null>()); // null = fetch failed / no history

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const names = useMemo(() => [...new Set(repos.map((r) => r.full_name))], [repos]);

  // Build the index lazily on the first real query; new repos join on later queries.
  useEffect(() => {
    if (debounced.length < 2) return;
    const missing = names.filter((n) => !index.current.has(n));
    if (!missing.length) return;
    let cancelled = false;
    setIndexing(true);
    void (async () => {
      const CONCURRENCY = 4;
      let next = 0;
      await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
          while (next < missing.length && !cancelled) {
            const fullName = missing[next++];
            try {
              const probe = await client.probeHistory(fullName);
              if (!probe) {
                index.current.set(fullName, null);
                continue;
              }
              const result = await fetchHistory(client, fullName, probe, loadCache(fullName));
              saveCache(fullName, result.cached);
              index.current.set(fullName, {
                text: result.cached.text,
                archive: parseOpenSessionJsonl(result.cached.text),
              });
            } catch {
              index.current.set(fullName, null);
            }
            if (!cancelled) setIndexedTick((n) => n + 1);
          }
        }),
      );
      if (!cancelled) setIndexing(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [debounced, names, client]);

  const hits = useMemo<SearchHit[]>(() => {
    if (debounced.length < 2) return [];
    const entries = [...index.current.entries()]
      .filter((e): e is [string, IndexEntry] => e[1] !== null)
      .map(([repo, entry]) => ({ repo, archive: entry.archive }));
    return searchArchives(entries, debounced, 50);
    // indexedTick re-runs this as archives stream in
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, indexedTick]);

  const terms = queryTerms(debounced);
  const searched = [...index.current.values()].filter((v) => v !== null).length;

  return (
    <section className="session-search">
      <div className="token-entry">
        <input
          type="search"
          placeholder="Search sessions — every human and model turn across your repos…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search sessions"
        />
        {query && (
          <button className="ghost" onClick={() => setQuery('')}>
            clear
          </button>
        )}
      </div>
      {debounced.length >= 2 && (
        <>
          <p className="fine search-status">
            {indexing
              ? `Searching… ${searched}/${names.length} repos indexed`
              : `${hits.length}${hits.length === 50 ? '+' : ''} result${hits.length === 1 ? '' : 's'} across ${searched} repo${searched === 1 ? '' : 's'}`}
          </p>
          <ul className="search-results">
            {hits.map((hit) => (
              <li key={`${hit.repo}:${hit.turnId}`}>
                <button
                  className="search-hit"
                  onClick={() => {
                    const entry = index.current.get(hit.repo);
                    if (!entry) return;
                    onOpen(
                      hit.repo,
                      entry.text,
                      `https://github.com/${hit.repo}/blob/HEAD/llm-turn-history.jsonl`,
                      { sessionIndex: hit.sessionIndex, turnId: hit.turnId },
                    );
                  }}
                >
                  <span className="search-hit-head">
                    <span className="repo-name">{hit.repo}</span>
                    <span className="fine">#{hit.sessionLabel}</span>
                    <span className={`msg-user ${hit.speakerKind}`}>{hit.speakerName}</span>
                    {hit.ts && <span className="fine">{new Date(hit.ts).toLocaleDateString()}</span>}
                  </span>
                  <span className="search-hit-excerpt">
                    {excerptSegments(hit.excerpt, terms).map((seg, i) =>
                      seg.match ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>,
                    )}
                  </span>
                </button>
              </li>
            ))}
            {!indexing && hits.length === 0 && <li className="status">No turns match.</li>}
          </ul>
        </>
      )}
    </section>
  );
}
