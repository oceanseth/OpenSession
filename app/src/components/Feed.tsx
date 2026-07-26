import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OAUTH_CLIENT_ID, beginLogin } from '../lib/auth';
import { GitHubClient, type HistoryCommit, type Repo } from '../lib/github';
import { RegistryClient, parseRepoInput, type RegistryRepo } from '../lib/registry';

const POLL_MS = 60_000;
const SCAN_PAGES = 10; // 1000 newest stars per scan pass

interface FeedProps {
  client: GitHubClient;
  token: string;
  onToken: (t: string) => void;
  onOpenSession: (title: string, text: string, sourceUrl?: string) => void;
  onOpenUrl: (url: string) => void;
  loadError?: string;
}

interface FollowLive {
  sha?: string;
  size?: number;
  changed?: boolean;
  lastCommit?: HistoryCommit;
}

export function Feed({ client, token, onToken, onOpenSession, onOpenUrl, loadError }: FeedProps) {
  const registry = useMemo(() => (token ? new RegistryClient(token) : null), [token]);
  const [login, setLogin] = useState<string>();
  const [follows, setFollows] = useState<RegistryRepo[]>([]);
  const [live, setLive] = useState<Record<number, FollowLive>>({});
  const [discovered, setDiscovered] = useState<RegistryRepo[]>([]);
  const [scan, setScan] = useState<{ scanned: number; queued: number; nextPage: number | null }>();
  const [status, setStatus] = useState<string>();
  const [submitInput, setSubmitInput] = useState('');
  const [submitStatus, setSubmitStatus] = useState<string>();
  const [urlInput, setUrlInput] = useState('');
  const [tokenInput, setTokenInput] = useState(token);
  const shaRef = useRef<Record<number, string>>({});

  const refreshFollows = useCallback(async () => {
    if (!registry) return [] as RegistryRepo[];
    const list = await registry.follows();
    setFollows(list);
    return list;
  }, [registry]);

  /** Live-probe followed repos (client-side, few repos) so new turns show fast. */
  const pollFollows = useCallback(
    async (list: RegistryRepo[]) => {
      const updates: Record<number, FollowLive> = {};
      await Promise.all(
        list.map(async (f) => {
          const probe = await client.probeHistory(f.full_name);
          if (!probe) return;
          const prev = shaRef.current[f.id];
          const changed = !!prev && prev !== probe.sha;
          shaRef.current[f.id] = probe.sha;
          updates[f.id] = { sha: probe.sha, size: probe.size, changed: changed || undefined };
          if (changed || !prev) {
            try {
              updates[f.id].lastCommit = await client.lastHistoryCommit(f.full_name);
            } catch {
              /* best effort */
            }
          }
        }),
      );
      setLive((cur) => {
        const next = { ...cur };
        for (const [id, u] of Object.entries(updates)) {
          const n = Number(id);
          next[n] = { ...cur[n], ...u, changed: u.changed ?? cur[n]?.changed };
        }
        return next;
      });
    },
    [client],
  );

  /**
   * Scan a window of starred repos and intersect with the hosted registry —
   * one API call instead of probing every starred repo against GitHub.
   */
  const scanStars = useCallback(
    async (startPage: number) => {
      if (!registry) return;
      setStatus(startPage === 1 ? 'Scanning your newest stars…' : 'Scanning more stars…');
      try {
        const { repos, more } = await client.starredRepos(startPage, SCAN_PAGES);
        const result = await registry.match(repos.map((r: Repo) => ({ id: r.id, full_name: r.full_name })));
        setDiscovered((cur) => {
          const seen = new Set(cur.map((r) => r.id));
          return [...cur, ...result.known.filter((r) => !seen.has(r.id))];
        });
        setScan((cur) => ({
          scanned: (startPage === 1 ? 0 : (cur?.scanned ?? 0)) + repos.length,
          queued: (startPage === 1 ? 0 : (cur?.queued ?? 0)) + result.queued,
          nextPage: more ? startPage + SCAN_PAGES : null,
        }));
        setStatus(undefined);
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      }
    },
    [client, registry],
  );

  useEffect(() => {
    if (!token || !registry) return;
    let cancelled = false;
    (async () => {
      try {
        const me = await client.viewer();
        if (cancelled) return;
        setLogin(me?.login);
        const list = await refreshFollows();
        void pollFollows(list);
        void scanStars(1);
      } catch (e) {
        if (!cancelled) setStatus(e instanceof Error ? e.message : String(e));
      }
    })();
    const id = setInterval(() => {
      void refreshFollows().then((list) => pollFollows(list));
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [token, registry, client, refreshFollows, pollFollows, scanStars]);

  const open = async (fullName: string, id?: number) => {
    setStatus(`Loading ${fullName}…`);
    try {
      const text = await client.fetchHistoryFile(fullName);
      if (id !== undefined) setLive((cur) => ({ ...cur, [id]: { ...cur[id], changed: false } }));
      setStatus(undefined);
      onOpenSession(fullName, text, `https://github.com/${fullName}/blob/HEAD/llm-turn-history.jsonl`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const follow = async (repo: RegistryRepo) => {
    if (!registry) return;
    await registry.follow(repo.id, repo.full_name);
    setDiscovered((cur) => cur.filter((r) => r.id !== repo.id));
    const list = await refreshFollows();
    void pollFollows(list);
  };

  const unfollow = async (repo: RegistryRepo) => {
    if (!registry) return;
    await registry.unfollow(repo.id);
    setFollows((cur) => cur.filter((r) => r.id !== repo.id));
  };

  const submit = async () => {
    if (!registry) return;
    const parsed = parseRepoInput(submitInput);
    if (!parsed) {
      setSubmitStatus('Enter owner/name or a github.com repository URL.');
      return;
    }
    setSubmitStatus(`Checking ${parsed}…`);
    try {
      await registry.submit(parsed);
      setSubmitStatus(undefined);
      setSubmitInput('');
      const list = await refreshFollows();
      void pollFollows(list);
    } catch (e) {
      setSubmitStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const followedIds = new Set(follows.map((f) => f.id));
  const discoverList = discovered.filter((r) => !followedIds.has(r.id));

  return (
    <div className="feed">
      <section className="connect card">
        {login ? (
          <div className="connect-row">
            <span>
              Signed in as <strong>@{login}</strong> · following {follows.length} repo{follows.length === 1 ? '' : 's'} · refreshing every {POLL_MS / 1000}s
            </span>
            <button
              className="ghost"
              onClick={() => {
                onToken('');
                setLogin(undefined);
                setFollows([]);
                setDiscovered([]);
                setScan(undefined);
                setTokenInput('');
              }}
            >
              Disconnect
            </button>
          </div>
        ) : (
          <div className="connect-row">
            {OAUTH_CLIENT_ID && (
              <div className="oauth-row">
                <span>Connect GitHub to build your feed:</span>
                <button onClick={() => beginLogin()}>Sign in with GitHub</button>
              </div>
            )}
            <details className="pat-fallback" open={!OAUTH_CLIENT_ID}>
              <summary>{OAUTH_CLIENT_ID ? 'Or use a personal access token' : 'Connect with a personal access token'}</summary>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  onToken(tokenInput.trim());
                }}
              >
                <label htmlFor="gh-token">
                  Paste a{' '}
                  <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noreferrer">
                    personal access token
                  </a>{' '}
                  (read-only is fine):
                </label>
                <div className="token-entry">
                  <input
                    id="gh-token"
                    type="password"
                    placeholder="github_pat_…"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                  />
                  <button type="submit" disabled={!tokenInput.trim()}>Connect</button>
                </div>
              </form>
            </details>
            <p className="fine">Your token is stored only in this browser's localStorage and sent only to api.github.com and the OpenSession registry (to identify you).</p>
            {loadError && <p className="status error">{loadError}</p>}
          </div>
        )}
      </section>

      {status && <p className="status">{status}</p>}

      {login && (
        <>
          <h2 className="section-title">Following</h2>
          {follows.length === 0 && (
            <p className="status">Not following anything yet — pick repos below or add one by name.</p>
          )}
          <ul className="feed-list">
            {follows.map((f) => (
              <li key={f.id} className={live[f.id]?.changed ? 'card changed' : 'card'}>
                <div className="feed-row">
                  <button className="feed-item" onClick={() => void open(f.full_name, f.id)}>
                    <div className="feed-item-head">
                      <span className="repo-name">{f.full_name}</span>
                      {live[f.id]?.changed && <span className="badge">new turns</span>}
                      {(live[f.id]?.size ?? f.history_size) != null && (
                        <span className="size">{(((live[f.id]?.size ?? f.history_size) as number) / 1024).toFixed(1)} KB of session history</span>
                      )}
                    </div>
                    {live[f.id]?.lastCommit && (
                      <p className="last-commit">
                        {live[f.id].lastCommit!.avatarUrl && <img src={live[f.id].lastCommit!.avatarUrl!} alt="" />}
                        <span>
                          {live[f.id].lastCommit!.authorLogin ?? live[f.id].lastCommit!.author ?? 'someone'} appended ·{' '}
                          {timeAgo(live[f.id].lastCommit!.date)} · “{live[f.id].lastCommit!.message}”
                        </span>
                      </p>
                    )}
                  </button>
                  <button className="ghost unfollow" title="Unfollow" onClick={() => void unfollow(f)}>
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <h2 className="section-title">From your stars</h2>
          {scan && (
            <p className="status">
              Scanned your {scan.scanned.toLocaleString()} newest starred repos against the registry
              {scan.queued > 0 && <> · {scan.queued.toLocaleString()} first-time repos queued for server-side verification (check back soon)</>}
              {scan.nextPage && (
                <>
                  {' · '}
                  <button className="ghost inline" onClick={() => void scanStars(scan.nextPage!)}>
                    scan {SCAN_PAGES * 100} more
                  </button>
                </>
              )}
            </p>
          )}
          {discoverList.length === 0 && scan && !scan.queued && (
            <p className="status">No additional open-session repos among your scanned stars.</p>
          )}
          <ul className="feed-list">
            {discoverList.map((r) => (
              <li key={r.id} className="card">
                <div className="feed-row">
                  <button className="feed-item" onClick={() => void open(r.full_name)}>
                    <div className="feed-item-head">
                      <span className="repo-name">{r.full_name}</span>
                      {r.history_size != null && <span className="size">{(r.history_size / 1024).toFixed(1)} KB of session history</span>}
                    </div>
                  </button>
                  <button className="follow" onClick={() => void follow(r)}>Follow</button>
                </div>
              </li>
            ))}
          </ul>

          <section className="card open-by-url">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <label htmlFor="submit-repo">Follow any repo by name — it's verified server-side and added to the shared registry:</label>
              <div className="token-entry">
                <input
                  id="submit-repo"
                  placeholder="owner/repo or https://github.com/owner/repo"
                  value={submitInput}
                  onChange={(e) => setSubmitInput(e.target.value)}
                />
                <button type="submit" disabled={!submitInput.trim()}>Follow</button>
              </div>
              {submitStatus && <p className="status error">{submitStatus}</p>}
            </form>
          </section>
        </>
      )}

      <section className="card open-by-url">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (urlInput.trim()) onOpenUrl(urlInput.trim());
          }}
        >
          <label htmlFor="archive-url">Or just view a session archive by URL (github blob or raw link), no account needed:</label>
          <div className="token-entry">
            <input
              id="archive-url"
              type="url"
              placeholder="https://github.com/owner/repo/blob/main/llm-turn-history.jsonl"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
            />
            <button type="submit" disabled={!urlInput.trim()}>View</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString();
}
