import { useMemo } from 'react';
import { excerptSegments, queryTerms, searchArchives, type SearchHit } from '@oslib/search';
import type { RepoEntry } from '../App';

/** Full-text search results across every followed repo's parsed archive. */
export function SearchPanel({
  query,
  entries,
  indexing,
  onOpenHit,
}: {
  query: string;
  entries: Map<string, RepoEntry>;
  indexing: number; // repos still loading their archive
  onOpenHit: (hit: SearchHit) => void;
}) {
  const hits = useMemo(() => {
    const searchable = [...entries.entries()]
      .filter(([, e]) => e.archive)
      .map(([repo, e]) => ({ repo, archive: e.archive! }));
    return searchArchives(searchable, query, 50);
  }, [entries, query]);

  const terms = queryTerms(query);
  const searched = [...entries.values()].filter((e) => e.archive).length;

  return (
    <div className="search-panel">
      <div className="search-panel-status muted">
        {indexing > 0
          ? `Searching… ${searched} repo${searched === 1 ? '' : 's'} indexed, ${indexing} loading`
          : `${hits.length}${hits.length === 50 ? '+' : ''} result${hits.length === 1 ? '' : 's'} across ${searched} repo${searched === 1 ? '' : 's'}`}
      </div>
      <div className="search-panel-results">
        {hits.map((hit) => (
          <button key={`${hit.repo}:${hit.turnId}`} className="search-hit" onClick={() => onOpenHit(hit)}>
            <span className="search-hit-head">
              <span className="repo-label">{hit.repo}</span>
              <span className="muted">#{hit.sessionLabel}</span>
              <span className={`badge ${hit.speakerKind}`}>{hit.speakerName}</span>
              {hit.ts && <span className="ts">{new Date(hit.ts).toLocaleDateString()}</span>}
            </span>
            <span className="search-hit-excerpt">
              {excerptSegments(hit.excerpt, terms).map((seg, i) =>
                seg.match ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>,
              )}
            </span>
          </button>
        ))}
        {indexing === 0 && hits.length === 0 && <p className="status">No turns match.</p>}
      </div>
    </div>
  );
}
