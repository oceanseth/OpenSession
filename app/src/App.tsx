import { useCallback, useEffect, useMemo, useState } from 'react';
import './App.css';
import { Chat } from './components/Chat';
import { Feed } from './components/Feed';
import { SessionView } from './components/SessionView';
import { completeLogin } from './lib/auth';
import { GitHubClient } from './lib/github';
import {
  IdentityClient,
  normalizeXHandle,
  onExtensionAttestation,
  type Identity,
} from './lib/identity';
import { parseOpenSessionJsonl, type ParsedArchive } from './lib/opensession';

type Tab = 'activity' | 'chat';
type View = { name: 'tabs' } | { name: 'session'; title: string; archive: ParsedArchive; sourceUrl?: string };

const TOKEN_KEY = 'opensession.github.token';
const X_PROMPT_DISMISSED_KEY = 'opensession.xprompt.dismissed';

export default function App() {
  const [token, setToken] = useState<string>(() => localStorage.getItem(TOKEN_KEY) ?? '');
  const [tab, setTab] = useState<Tab>('activity');
  const [view, setView] = useState<View>({ name: 'tabs' });
  const [loadError, setLoadError] = useState<string>();
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [identityLoaded, setIdentityLoaded] = useState(false);
  const [xInput, setXInput] = useState('');
  const [xStatus, setXStatus] = useState<string>();
  const [xPromptDismissed, setXPromptDismissed] = useState(
    () => localStorage.getItem(X_PROMPT_DISMISSED_KEY) === '1',
  );
  const client = useMemo(() => new GitHubClient(token || undefined), [token]);
  const identityClient = useMemo(() => (token ? new IdentityClient(token) : null), [token]);

  const saveToken = (t: string) => {
    setToken(t);
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else {
      localStorage.removeItem(TOKEN_KEY);
      setIdentity(null);
      setIdentityLoaded(false);
    }
  };

  // Load my identity once signed in; accept extension attestations any time.
  useEffect(() => {
    if (!identityClient) return;
    let cancelled = false;
    identityClient
      .mine()
      .then((i) => {
        if (!cancelled) {
          setIdentity(i);
          setIdentityLoaded(true);
        }
      })
      .catch(() => setIdentityLoaded(true));
    const unsub = onExtensionAttestation((handle) => {
      void identityClient.linkX(handle, 'extension').then((i) => setIdentity(i));
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [identityClient]);

  const linkX = async () => {
    if (!identityClient) return;
    const handle = normalizeXHandle(xInput);
    if (!handle) {
      setXStatus('Enter a valid X username (letters, digits, underscore; max 15).');
      return;
    }
    setXStatus('Linking…');
    try {
      setIdentity(await identityClient.linkX(handle));
      setXStatus(undefined);
      setXInput('');
    } catch (e) {
      setXStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const openArchive = useCallback((title: string, text: string, sourceUrl?: string) => {
    setLoadError(undefined);
    setView({ name: 'session', title, archive: parseOpenSessionJsonl(text), sourceUrl });
  }, []);

  const openUrl = useCallback(
    async (url: string) => {
      setLoadError(undefined);
      try {
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
    const m = window.location.hash.match(/^#\/session\?src=(.+)$/);
    if (m) void openUrl(decodeURIComponent(m[1]));
  }, [openUrl]);

  // OAuth callback: ?code=…&state=… → exchange for a token.
  useEffect(() => {
    completeLogin()
      .then((t) => {
        if (t) saveToken(t);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showXPrompt = !!token && identityLoaded && !identity && !xPromptDismissed;

  return (
    <div className="app">
      <header className="masthead">
        <div className="masthead-inner">
          <h1 onClick={() => setView({ name: 'tabs' })}>
            <img src="/icon.png" alt="" className="mark" />
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
            {identity && (
              <span className="linked-as">
                linked: <a href={`https://x.com/${identity.x_handle}`} target="_blank" rel="noreferrer">@{identity.x_handle}</a>
              </span>
            )}
          </nav>
        </div>
      </header>

      {showXPrompt && (
        <div className="x-prompt">
          <form
            className="x-prompt-inner"
            onSubmit={(e) => {
              e.preventDefault();
              void linkX();
            }}
          >
            <span>
              <strong>Verify your X account</strong> — link your GitHub identity to your X handle so other
              OpenSession users can message you about your sessions.
            </span>
            <span className="token-entry">
              <input
                placeholder="@yourhandle"
                value={xInput}
                onChange={(e) => setXInput(e.target.value)}
              />
              <button type="submit" disabled={!xInput.trim()}>Link</button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setXPromptDismissed(true);
                  localStorage.setItem(X_PROMPT_DISMISSED_KEY, '1');
                }}
              >
                Later
              </button>
            </span>
            {xStatus && <span className="status error">{xStatus}</span>}
          </form>
        </div>
      )}

      {view.name === 'tabs' && token && (
        <nav className="tabbar">
          <button className={tab === 'activity' ? 'tab active' : 'tab'} onClick={() => setTab('activity')}>
            Activity
          </button>
          <button className={tab === 'chat' ? 'tab active' : 'tab'} onClick={() => setTab('chat')}>
            Chat
          </button>
        </nav>
      )}

      <main>
        {view.name === 'tabs' && (tab === 'activity' || !token) && (
          <Feed
            client={client}
            token={token}
            onToken={saveToken}
            onOpenSession={(title, text, sourceUrl) => openArchive(title, text, sourceUrl)}
            onOpenUrl={openUrl}
            loadError={loadError}
          />
        )}
        {view.name === 'tabs' && tab === 'chat' && token && (
          <Chat client={client} token={token} myIdentity={identity} />
        )}
        {view.name === 'session' && (
          <SessionView
            title={view.title}
            archive={view.archive}
            sourceUrl={view.sourceUrl}
            onBack={() => setView({ name: 'tabs' })}
          />
        )}
      </main>

      <footer>
        <p>
          Built under the Open Session License — this site's own build history is an open session log.
          In-page X DMs via the xChatHub bridge and session discussion threads are on the way.
        </p>
      </footer>
    </div>
  );
}
