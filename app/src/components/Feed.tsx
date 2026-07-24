import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GitHubClient,
  HISTORY_FILE,
  scanForSessionRepos,
  type SessionRepo,
} from '../lib/github';

const POLL_MS = 60_000;

interface FeedProps {
  client: GitHubClient;
  token: string;
  onToken: (t: string) => void;
  onOpenSession: (title: string, text: string, sourceUrl?: string) => void;
  onOpenUrl: (url: string) => void;
  loadError?: string;
}

export function Feed({ client, token, onToken, onOpenSession, onOpenUrl, loadError }: FeedProps) {
  const [login, setLogin] = useState<string>();
  const [items, setItems] = useState<SessionRepo[]>([]);
  const [status, setStatus] = useState<string>();
  const [changed, setChanged] = useState<Record<string, boolean>>({});
  const [urlInput, setUrlInput] = useState('');
  const [tokenInput, setTokenInput] = useState(token);
  const shaRef = useRef<Record<string, string>>({});

  const refresh = useCallback(
    async (isPoll: boolean) => {
      if (!token) return;
      try {
        if (!isPoll) setStatus('Loading starred repos…');
        const me = await client.viewer();
        setLogin(me?.login);
        const starred = await client.starredRepos();
        if (!isPoll) setStatus(`Scanning ${starred.length} starred repos for ${HISTORY_FILE}…`);
        const found = await scanForSessionRepos(client, starred);
        // Newest activity first; flag repos whose history blob changed since last look.
        found.sort((a, b) => (b.repo.pushed_at ?? '').localeCompare(a.repo.pushed_at ?? ''));
        const nextChanged: Record<string, boolean> = {};
        for (const f of found) {
          const prev = shaRef.current[f.repo.full_name];
          if (prev && prev !== f.historySha) nextChanged[f.repo.full_name] = true;
          shaRef.current[f.repo.full_name] = f.historySha;
        }
        if (isPoll) setChanged((c) => ({ ...c, ...nextChanged }));
        // Annotate with last commit info (who appended, when) — best effort.
        await Promise.all(
          found.map(async (f) => {
            try {
              f.lastCommit = await client.lastHistoryCommit(f.repo.full_name);
            } catch {
              /* rate-limited or empty — leave undefined */
            }
          }),
        );
        setItems(found);
        setStatus(
          found.length
            ? undefined
            : 'None of your starred repos ship a session history yet. Star some open-session repos — or load any archive by URL below.',
        );
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      }
    },
    [client, token],
  );

  useEffect(() => {
    void refresh(false);
    const id = setInterval(() => void refresh(true), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const open = async (item: SessionRepo) => {
    setStatus(`Loading ${item.repo.full_name}…`);
    try {
      const text = await client.fetchHistoryFile(item.repo.full_name, item.repo.default_branch);
      setChanged((c) => ({ ...c, [item.repo.full_name]: false }));
      setStatus(undefined);
      onOpenSession(
        item.repo.full_name,
        text,
        `${item.repo.html_url}/blob/${item.repo.default_branch}/${HISTORY_FILE}`,
      );
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="feed">
      <section className="connect card">
        {login ? (
          <div className="connect-row">
            <span>
              Feed for <strong>@{login}</strong>'s starred repos · live, refreshing every {POLL_MS / 1000}s
            </span>
            <button className="ghost" onClick={() => { onToken(''); setLogin(undefined); setItems([]); setTokenInput(''); }}>
              Disconnect
            </button>
          </div>
        ) : (
          <form
            className="connect-row"
            onSubmit={(e) => {
              e.preventDefault();
              onToken(tokenInput.trim());
            }}
          >
            <label htmlFor="gh-token">
              Connect GitHub to build your feed — paste a{' '}
              <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noreferrer">
                personal access token
              </a>{' '}
              (read-only is fine; OAuth login is coming):
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
            <p className="fine">Stored only in this browser's localStorage; all API calls go straight to api.github.com.</p>
          </form>
        )}
      </section>

      {status && <p className="status">{status}</p>}

      <ul className="feed-list">
        {items.map((item) => (
          <li key={item.repo.full_name} className={changed[item.repo.full_name] ? 'card changed' : 'card'}>
            <button className="feed-item" onClick={() => void open(item)}>
              <div className="feed-item-head">
                <span className="repo-name">{item.repo.full_name}</span>
                {changed[item.repo.full_name] && <span className="badge">new turns</span>}
                <span className="size">{(item.historySize / 1024).toFixed(1)} KB of session history</span>
              </div>
              {item.repo.description && <p className="desc">{item.repo.description}</p>}
              {item.lastCommit && (
                <p className="last-commit">
                  {item.lastCommit.avatarUrl && <img src={item.lastCommit.avatarUrl} alt="" />}
                  <span>
                    {item.lastCommit.authorLogin ?? item.lastCommit.author ?? 'someone'} appended ·{' '}
                    {timeAgo(item.lastCommit.date)} · “{item.lastCommit.message}”
                  </span>
                </p>
              )}
            </button>
          </li>
        ))}
      </ul>

      <section className="card open-by-url">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (urlInput.trim()) onOpenUrl(urlInput.trim());
          }}
        >
          <label htmlFor="archive-url">Or open any session archive by URL (github blob or raw link):</label>
          <div className="token-entry">
            <input
              id="archive-url"
              type="url"
              placeholder={`https://github.com/owner/repo/blob/main/${HISTORY_FILE}`}
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
            />
            <button type="submit" disabled={!urlInput.trim()}>View</button>
          </div>
          {loadError && <p className="status error">{loadError}</p>}
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
