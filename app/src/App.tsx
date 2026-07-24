import { useCallback, useEffect, useMemo, useState } from 'react';
import './App.css';
import { Feed } from './components/Feed';
import { SessionView } from './components/SessionView';
import { GitHubClient } from './lib/github';
import { parseOpenSessionJsonl, type ParsedArchive } from './lib/opensession';

type View = { name: 'feed' } | { name: 'session'; title: string; archive: ParsedArchive; sourceUrl?: string };

const TOKEN_KEY = 'opensession.github.token';

export default function App() {
  const [token, setToken] = useState<string>(() => localStorage.getItem(TOKEN_KEY) ?? '');
  const [view, setView] = useState<View>({ name: 'feed' });
  const [loadError, setLoadError] = useState<string>();
  const client = useMemo(() => new GitHubClient(token || undefined), [token]);

  const saveToken = (t: string) => {
    setToken(t);
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  };

  const openArchive = useCallback((title: string, text: string, sourceUrl?: string) => {
    setLoadError(undefined);
    setView({ name: 'session', title, archive: parseOpenSessionJsonl(text), sourceUrl });
  }, []);

  const openUrl = useCallback(
    async (url: string) => {
      setLoadError(undefined);
      try {
        // Accept github.com blob URLs and rewrite to raw.
        const raw = url
          .replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\//, 'https://raw.githubusercontent.com/$1/$2/')
          .replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/raw\//, 'https://raw.githubusercontent.com/$1/$2/');
        const res = await fetch(raw);
        if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
        openArchive(new URL(raw).pathname.split('/').slice(1, 3).join('/'), await res.text(), url);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    },
    [openArchive],
  );

  // Deep link: #/session?src=<url>
  useEffect(() => {
    const hash = window.location.hash;
    const m = hash.match(/^#\/session\?src=(.+)$/);
    if (m) void openUrl(decodeURIComponent(m[1]));
  }, [openUrl]);

  return (
    <div className="app">
      <header className="masthead">
        <div className="masthead-inner">
          <h1 onClick={() => setView({ name: 'feed' })}>
            open<span className="accent">session</span>
          </h1>
          <p className="tagline">
            The live feed for human–AI collaboration. Watch <code>llm-turn-history.jsonl</code> session logs
            evolve in realtime across the repos you star — replay them, discuss them, compare models on them.
          </p>
          <nav>
            <a href="https://github.com/oceanseth/OpenSession" target="_blank" rel="noreferrer">GitHub</a>
            <a
              href="https://github.com/oceanseth/InfiniteMirror/blob/main/OPEN-SESSION-LICENSE.md"
              target="_blank"
              rel="noreferrer"
            >
              The Open Session License
            </a>
          </nav>
        </div>
      </header>

      <main>
        {view.name === 'feed' && (
          <Feed
            client={client}
            token={token}
            onToken={saveToken}
            onOpenSession={(title, text, sourceUrl) => openArchive(title, text, sourceUrl)}
            onOpenUrl={openUrl}
            loadError={loadError}
          />
        )}
        {view.name === 'session' && (
          <SessionView
            title={view.title}
            archive={view.archive}
            sourceUrl={view.sourceUrl}
            onBack={() => setView({ name: 'feed' })}
          />
        )}
      </main>

      <footer>
        <p>
          Built under the Open Session License — this site's own build history is an open session log.
          GitHub ⇄ X identity linking and in-feed discussion are on the way.
        </p>
      </footer>
    </div>
  );
}
