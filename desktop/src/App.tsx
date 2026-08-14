import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GitHubClient, type Repo } from '@oslib/github';
import { parseOpenSessionJsonl, type ParsedArchive } from '@oslib/opensession';
import { BenchPanel } from './components/BenchPanel';
import { LeakScanPanel } from './components/LeakScanPanel';
import { Login } from './components/Login';
import { SettingsModal } from './components/SettingsModal';
import { Sidebar } from './components/Sidebar';
import { ThreadPanel, type ThreadView } from './components/ThreadPanel';
import { TurnStream } from './components/TurnStream';
import { markSeen, seenCount, sessionKey } from './lib/seen';
import { useSettings } from './lib/settings';
import { DesktopThreadsClient, type Thread } from './lib/threads';

const TOKEN_KEY = 'opensession.desktop.token';
const POLL_MS = 30_000;

export interface RepoEntry {
  repo: Repo;
  sha?: string; // history file blob sha — change means new turns
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
  const [mainView, setMainView] = useState<'session' | 'threads'>('session');
  const [benchOpen, setBenchOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [threadView, setThreadView] = useState<ThreadView | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [threadsByRepo, setThreadsByRepo] = useState<Map<string, Thread[]>>(new Map());
  const [flashing, setFlashing] = useState<Set<string>>(new Set());
  const [, bumpSeen] = useState(0); // re-render after markSeen writes
  const settings = useSettings();
  const client = useMemo(() => new GitHubClient(token || undefined), [token]);
  const threadsClient = useMemo(() => (token ? new DesktopThreadsClient(token) : null), [token]);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  const loadRepoThreads = useCallback(
    (fullName: string) => {
      if (!threadsClient) return;
      threadsClient
        .list(fullName)
        .then((ts) => setThreadsByRepo((prev) => new Map(prev).set(fullName, ts)))
        .catch(() => {
          /* threads are additive — a failed load never blocks the turn stream */
        });
    },
    [threadsClient],
  );

  const fetchArchive = useCallback(
    async (fullName: string): Promise<ParsedArchive> => {
      const text = await client.fetchHistoryFile(fullName);
      return parseOpenSessionJsonl(text);
    },
    [client],
  );

  const saveToken = (t: string) => {
    setToken(t);
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
    setEntries(new Map());
    setSelection(null);
    setViewer(null);
    setThreadView(null);
    setMainView('session');
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
                setEntries((prev) => new Map(prev).set(repo.full_name, { repo, sha: probe.sha }));
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

  // Live updates: poll history-file shas; changed sha → refetch turns, flash the repo.
  useEffect(() => {
    if (!token) return;
    const timer = setInterval(() => {
      for (const [fullName, entry] of entriesRef.current) {
        void client.probeHistory(fullName).then(async (probe) => {
          if (!probe || probe.sha === entry.sha) return;
          const archive = entry.archive ? await fetchArchive(fullName).catch(() => undefined) : undefined;
          setEntries((prev) => {
            const cur = prev.get(fullName);
            if (!cur) return prev;
            return new Map(prev).set(fullName, {
              ...cur,
              sha: probe.sha,
              archive: archive ?? cur.archive,
            });
          });
          setFlashing((prev) => new Set(prev).add(fullName));
          setTimeout(
            () =>
              setFlashing((prev) => {
                const next = new Set(prev);
                next.delete(fullName);
                return next;
              }),
            4000,
          );
        });
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [client, fetchArchive, token]);

  const openRepo = useCallback(
    (fullName: string) => {
      const entry = entriesRef.current.get(fullName);
      if (!entry || entry.loading) return;
      setMainView('session');
      if (entry.archive) {
        setSelection({ repo: fullName, session: 0 });
        return;
      }
      setEntries((prev) => new Map(prev).set(fullName, { ...entry, loading: true, error: undefined }));
      loadRepoThreads(fullName);
      void fetchArchive(fullName)
        .then((archive) => {
          setEntries((prev) => new Map(prev).set(fullName, { repo: entry.repo, sha: entry.sha, archive }));
          setSelection({ repo: fullName, session: Math.max(0, archive.sessions.length - 1) });
        })
        .catch((e) => {
          setEntries((prev) =>
            new Map(prev).set(fullName, {
              repo: entry.repo,
              sha: entry.sha,
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        });
    },
    [fetchArchive, loadRepoThreads],
  );

  const selected = selection ? entries.get(selection.repo) : undefined;
  const session = selected?.archive?.sessions[selection?.session ?? 0];

  // Viewing a session marks its turns seen.
  useEffect(() => {
    if (!selection || !session || mainView !== 'session') return;
    markSeen(
      sessionKey(selection.repo, session.session.sid, selection.session),
      session.messages.length,
    );
    bumpSeen((n) => n + 1);
  }, [selection, session, mainView]);

  // Unseen turns per repo/session, derived from loaded archives.
  const unseen = useMemo(() => {
    const bySession = new Map<string, number>();
    const byRepo = new Map<string, number>();
    for (const [fullName, entry] of entries) {
      if (!entry.archive) continue;
      let repoTotal = 0;
      entry.archive.sessions.forEach((s, i) => {
        const key = sessionKey(fullName, s.session.sid, i);
        const n = Math.max(0, s.messages.length - seenCount(key));
        bySession.set(key, n);
        repoTotal += n;
      });
      byRepo.set(fullName, repoTotal);
    }
    return { bySession, byRepo };
  }, [entries]);

  if (!token) return <Login onToken={saveToken} />;

  const repoThreads = selection ? (threadsByRepo.get(selection.repo) ?? []) : [];
  const threadsByTurn = new Map<string, Thread[]>();
  for (const t of repoThreads) {
    threadsByTurn.set(t.turn_id, [...(threadsByTurn.get(t.turn_id) ?? []), t]);
  }

  const rightRail =
    threadView && threadsClient ? (
      <ThreadPanel
        client={threadsClient}
        view={threadView}
        onView={setThreadView}
        onClose={() => setThreadView(null)}
        onThreadsChanged={loadRepoThreads}
      />
    ) : scanOpen && selection ? (
      <LeakScanPanel repo={selection.repo} token={token} />
    ) : benchOpen && selection ? (
      <BenchPanel repo={selection.repo} onOpenSettings={() => setSettingsOpen(true)} />
    ) : null;

  return (
    <div className="shell">
      <Sidebar
        viewer={viewer}
        entries={entries}
        scanStatus={scanStatus}
        selection={mainView === 'session' ? selection : null}
        unseenByRepo={unseen.byRepo}
        unseenBySession={unseen.bySession}
        flashing={flashing}
        threadsClient={threadsClient}
        onOpenRepo={openRepo}
        onSelect={(s) => {
          setMainView('session');
          setSelection(s);
        }}
        onOpenThreads={() => {
          setMainView('threads');
          setThreadView({ kind: 'global' });
        }}
        onOpenThread={(id) => setThreadView({ kind: 'detail', id })}
        onOpenSettings={() => setSettingsOpen(true)}
        onSignOut={() => saveToken('')}
      />
      <div className="main">
        {mainView === 'session' && selection && selected?.archive && session ? (
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
              <div className="header-actions">
                <button
                  className="bench-toggle"
                  onClick={() => {
                    setScanOpen((v) => !v);
                    setBenchOpen(false);
                    setThreadView(null);
                  }}
                >
                  {scanOpen && !threadView ? 'Hide scan' : '🛡 Leak scan'}
                </button>
                <button
                  className="bench-toggle"
                  onClick={() => {
                    setBenchOpen((v) => !v);
                    setScanOpen(false);
                    setThreadView(null);
                  }}
                >
                  {benchOpen && !threadView && !scanOpen ? 'Hide benchmarks' : '⚡ Benchmarks'}
                </button>
              </div>
            </header>
            <div className="content">
              <TurnStream
                session={session}
                threadsByTurn={threadsByTurn}
                onOpenThread={(id) => setThreadView({ kind: 'detail', id })}
                onDiscuss={(turn) =>
                  setThreadView({ kind: 'new', repo: selection.repo, turn })
                }
              />
              {rightRail}
            </div>
          </>
        ) : mainView === 'threads' ? (
          <div className="content">
            <div className="empty">Global discussions — pick a thread on the right.</div>
            {rightRail}
          </div>
        ) : (
          <div className="content">
            <div className="empty">
              {selected?.loading
                ? `Loading ${selection?.repo}…`
                : (selected?.error ?? 'Pick a repo on the left — its sessions appear as channels.')}
            </div>
            {rightRail}
          </div>
        )}
      </div>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
