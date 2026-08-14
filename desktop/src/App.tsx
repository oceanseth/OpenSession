import { useCallback, useEffect, useMemo, useState } from 'react';
import { GitHubClient, type Repo } from '@oslib/github';
import { parseOpenSessionJsonl, type ParsedArchive } from '@oslib/opensession';
import { BenchPanel } from './components/BenchPanel';
import { Login } from './components/Login';
import { Sidebar } from './components/Sidebar';
import { TurnStream } from './components/TurnStream';

const TOKEN_KEY = 'opensession.desktop.token';

export interface RepoEntry {
  repo: Repo;
  archive?: ParsedArchive;
  loading?: boolean;
  error?: string;
}

export interface Selection {
  repo: string; // full_name
  session: number; // index into archive.sessions
}

export default function App() {
  const [token, setToken] = useState<string>(() => localStorage.getItem(TOKEN_KEY) ?? '');
  const [viewer, setViewer] = useState<{ login: string; avatar_url: string } | null>(null);
  const [entries, setEntries] = useState<Map<string, RepoEntry>>(new Map());
  const [scanStatus, setScanStatus] = useState<string>();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [benchOpen, setBenchOpen] = useState(false);
  const client = useMemo(() => new GitHubClient(token || undefined), [token]);

  const saveToken = (t: string) => {
    setToken(t);
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
    setEntries(new Map());
    setSelection(null);
    setViewer(null);
  };

  // Scan starred repos for llm-turn-history.jsonl (same probe the web feed uses).
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        setScanStatus('Loading starred repos…');
        const me = await client.viewer();
        if (cancelled) return;
        setViewer(me);
        const { repos, more } = await client.starredRepos(1, 3);
        if (cancelled) return;
        setScanStatus(`Probing ${repos.length} starred repos for session logs…`);
        let found = 0;
        const CONCURRENCY = 8;
        let next = 0;
        await Promise.all(
          Array.from({ length: CONCURRENCY }, async () => {
            while (next < repos.length && !cancelled) {
              const repo = repos[next++];
              const probe = await client.probeHistory(repo.full_name);
              if (probe && !cancelled) {
                found++;
                setEntries((prev) => new Map(prev).set(repo.full_name, { repo }));
                setScanStatus(`Probing… ${found} session repo${found === 1 ? '' : 's'} found`);
              }
            }
          }),
        );
        if (!cancelled) {
          setScanStatus(
            found === 0
              ? 'No starred repos carry llm-turn-history.jsonl yet — star one that does.'
              : more
                ? `${found} session repos (first 300 stars scanned)`
                : undefined,
          );
        }
      } catch (e) {
        if (!cancelled) setScanStatus(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, token]);

  const openRepo = useCallback(
    (fullName: string) => {
      const entry = entries.get(fullName);
      if (!entry || entry.loading) return;
      if (entry.archive) {
        setSelection({ repo: fullName, session: 0 });
        return;
      }
      setEntries((prev) => new Map(prev).set(fullName, { ...entry, loading: true, error: undefined }));
      void client
        .fetchHistoryFile(fullName)
        .then((text) => {
          const archive = parseOpenSessionJsonl(text);
          setEntries((prev) => new Map(prev).set(fullName, { repo: entry.repo, archive }));
          setSelection({ repo: fullName, session: Math.max(0, archive.sessions.length - 1) });
        })
        .catch((e) => {
          setEntries((prev) =>
            new Map(prev).set(fullName, {
              repo: entry.repo,
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        });
    },
    [client, entries],
  );

  if (!token) return <Login onToken={saveToken} />;

  const selected = selection ? entries.get(selection.repo) : undefined;
  const session = selected?.archive?.sessions[selection?.session ?? 0];

  return (
    <div className="shell">
      <Sidebar
        viewer={viewer}
        entries={entries}
        scanStatus={scanStatus}
        selection={selection}
        onOpenRepo={openRepo}
        onSelect={setSelection}
        onSignOut={() => saveToken('')}
      />
      <div className="main">
        {selection && selected?.archive && session ? (
          <>
            <header className="channel-header">
              <div>
                <h2>
                  {selection.repo}
                  <span className="channel-session">
                    #{session.session.name ?? session.session.session ?? `session ${selection.session + 1}`}
                  </span>
                </h2>
                <span className="channel-sub">
                  {session.messages.length} turns
                  {session.session.tool ? ` · ${session.session.tool}` : ''}
                </span>
              </div>
              <button className="bench-toggle" onClick={() => setBenchOpen((v) => !v)}>
                {benchOpen ? 'Hide benchmarks' : '⚡ Benchmarks'}
              </button>
            </header>
            <div className="content">
              <TurnStream session={session} />
              {benchOpen && <BenchPanel repo={selection.repo} />}
            </div>
          </>
        ) : (
          <div className="empty">
            {selected?.loading
              ? `Loading ${selection?.repo}…`
              : (selected?.error ?? 'Pick a repo on the left — its sessions appear as channels.')}
          </div>
        )}
      </div>
    </div>
  );
}
