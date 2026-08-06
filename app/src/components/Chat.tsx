import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Contributor, GitHubClient } from '../lib/github';
import { IdentityClient, type Identity } from '../lib/identity';
import { RegistryClient } from '../lib/registry';
import type { ConversationRow, DmMessage, XChatConnector, XChatStatus } from '../lib/xchat';

const REFRESH_MS = 120_000;
const THREAD_POLL_MS = 20_000;

/** A contributor across followed repos, with their linked X identity (if any). */
interface Person extends Contributor {
  repos: string[];
  identity?: Identity;
}

interface ChatProps {
  client: GitHubClient;
  token: string;
  myIdentity: Identity | null;
  connector: XChatConnector;
}

export function Chat({ client, token, myIdentity, connector }: ChatProps) {
  const registry = useMemo(() => new RegistryClient(token), [token]);
  const identityClient = useMemo(() => new IdentityClient(token), [token]);
  const [people, setPeople] = useState<Person[]>([]);
  const [selected, setSelected] = useState<number>();
  const [status, setStatus] = useState<string>('Loading contributors…');
  const [xstatus, setXstatus] = useState<XChatStatus>(connector.status);

  useEffect(() => connector.onStatus(setXstatus), [connector]);

  const load = useCallback(async () => {
    try {
      const follows = await registry.follows();
      if (follows.length === 0) {
        setPeople([]);
        setStatus('Follow some repos in the Activity tab first — their contributors appear here.');
        return;
      }
      const byId = new Map<number, Person>();
      await Promise.all(
        follows.map(async (f) => {
          try {
            const contributors = await client.historyContributors(f.full_name);
            for (const c of contributors) {
              const cur = byId.get(c.id);
              if (!cur) {
                byId.set(c.id, { ...c, repos: [f.full_name] });
              } else {
                cur.commits += c.commits;
                cur.repos.push(f.full_name);
                if (c.lastActive > cur.lastActive) cur.lastActive = c.lastActive;
              }
            }
          } catch {
            /* repo fetch failed — skip */
          }
        }),
      );
      const identities = await identityClient.resolve([...byId.keys()]);
      const list = [...byId.values()].map((p) => ({ ...p, identity: identities[p.id] }));
      list.sort((a, b) => (b.identity ? 1 : 0) - (a.identity ? 1 : 0) || b.lastActive.localeCompare(a.lastActive));
      setPeople(list);
      setStatus(list.length === 0 ? 'No contributors found on your followed repos yet.' : '');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }, [client, registry, identityClient]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const person = people.find((p) => p.id === selected);

  return (
    <div className="chat">
      <aside className="chat-list card">
        <header className="chat-list-head">
          <span>Contributors</span>
          <span className="fine">
            {people.filter((p) => p.identity).length} on X ·{' '}
            {xstatus.connected ? 'DMs live' : xstatus.available ? 'open x.com for DMs' : 'extension not detected'}
          </span>
        </header>
        {status && <p className="status chat-status">{status}</p>}
        <ul>
          {people.map((p) => (
            <li key={p.id}>
              <button className={p.id === selected ? 'chat-row selected' : 'chat-row'} onClick={() => setSelected(p.id)}>
                <img src={p.avatarUrl} alt="" />
                <span className="chat-row-main">
                  <span className="chat-row-name">
                    {p.login}
                    {p.identity && <span className="x-handle">@{p.identity.x_handle}</span>}
                  </span>
                  <span className="chat-row-sub">
                    {p.commits} append{p.commits === 1 ? '' : 's'} · {p.repos.length} repo{p.repos.length === 1 ? '' : 's'}
                  </span>
                </span>
                {p.identity ? <span className="dot linked" title="X linked" /> : <span className="dot" title="not linked" />}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="chat-pane card">
        {person?.identity && xstatus.connected ? (
          <ConversationPane key={person.id} connector={connector} handle={person.identity.x_handle} login={person.login} />
        ) : person ? (
          <PersonCard person={person} xstatus={xstatus} />
        ) : (
          <div className="chat-empty">
            <p>
              {myIdentity
                ? `You're linked as @${myIdentity.x_handle}. Select a contributor to message them on X.`
                : 'Select a contributor to see their linked X identity.'}
            </p>
            {!xstatus.available && (
              <p className="fine">
                Install the{' '}
                <a
                  href="https://github.com/oceanseth/xChatHub#install-the-opensession-connected-version-this-fork"
                  target="_blank"
                  rel="noreferrer"
                >
                  OpenSession fork of xChatHub
                </a>{' '}
                to read and send X DMs right here (your browser talks to x.com directly — messages never touch
                OpenSession servers). Note: the Chrome Web Store xChat is the upstream build without the
                OpenSession connector — the fork must be loaded unpacked.
              </p>
            )}
            {xstatus.available && !xstatus.connected && (
              <p className="fine">
                xChatHub detected — <a href="https://x.com" target="_blank" rel="noreferrer">open an x.com tab</a>{' '}
                (keep its window visible) to light up in-page DMs.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function PersonCard({ person, xstatus }: { person: Person; xstatus: XChatStatus }) {
  return (
    <div className="chat-person">
      <img className="chat-avatar" src={person.avatarUrl} alt="" />
      <h3>
        <a href={`https://github.com/${person.login}`} target="_blank" rel="noreferrer">{person.login}</a>
        {person.identity && (
          <>
            {' '}
            ·{' '}
            <a href={`https://x.com/${person.identity.x_handle}`} target="_blank" rel="noreferrer">
              @{person.identity.x_handle}
            </a>
          </>
        )}
      </h3>
      <p className="fine">
        Active on {person.repos.join(', ')} · last append {new Date(person.lastActive).toLocaleDateString()}
      </p>
      {person.identity ? (
        <>
          <a className="dm-button" href={`https://x.com/${person.identity.x_handle}`} target="_blank" rel="noreferrer">
            Message @{person.identity.x_handle} on X
          </a>
          <p className="fine">
            {xstatus.available ? (
              'Open an x.com tab (window visible) and this pane becomes a live DM thread.'
            ) : (
              <>
                In-page DMs need the{' '}
                <a
                  href="https://github.com/oceanseth/xChatHub#install-the-opensession-connected-version-this-fork"
                  target="_blank"
                  rel="noreferrer"
                >
                  OpenSession fork
                </a>{' '}
                loaded unpacked — the Web Store build lacks the connector.
              </>
            )}
          </p>
        </>
      ) : (
        <p className="status">
          {person.login} hasn't linked an X account on OpenSession yet — you can still reach them through their GitHub
          profile.
        </p>
      )}
    </div>
  );
}

type ThreadState =
  | { phase: 'searching' }
  | { phase: 'none' }
  | { phase: 'loaded'; conversationId: string; title: string | null; messages: DmMessage[] }
  | { phase: 'error'; message: string };

export function ConversationPane({ connector, handle, login }: { connector: XChatConnector; handle: string; login: string }) {
  const [thread, setThread] = useState<ThreadState>({ phase: 'searching' });
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const convRef = useRef<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);

  const findAndRead = useCallback(async () => {
    try {
      let conversationId = convRef.current;
      if (!conversationId) {
        const rows = await connector.searchConversations(handle);
        const needle = handle.toLowerCase();
        const row = rows.find(
          (r: ConversationRow) =>
            r.title.toLowerCase().includes(needle) || r.details.some((d) => d.toLowerCase().includes(`@${needle}`)),
        ) ?? rows[0];
        if (!row) {
          setThread({ phase: 'none' });
          return;
        }
        conversationId = row.id;
        convRef.current = row.id;
      }
      const r = await connector.readMessages(conversationId);
      setThread({ phase: 'loaded', conversationId: r.conversationId, title: r.title, messages: r.messages });
    } catch (e) {
      setThread({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, [connector, handle]);

  useEffect(() => {
    setThread({ phase: 'searching' });
    convRef.current = undefined;
    void findAndRead();
    const id = setInterval(() => {
      if (convRef.current) void findAndRead();
    }, THREAD_POLL_MS);
    return () => clearInterval(id);
  }, [findAndRead]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [thread]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await connector.sendMessage(text, convRef.current);
      setDraft('');
      await findAndRead();
    } catch (e) {
      setThread({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="thread">
      <header className="thread-head">
        <span>
          @{handle} <span className="fine">({login} on GitHub)</span>
        </span>
        <a href={`https://x.com/${handle}`} target="_blank" rel="noreferrer" className="fine">
          open on X ↗
        </a>
      </header>

      {thread.phase === 'searching' && <p className="status thread-status">Looking up your DM thread with @{handle}…</p>}
      {thread.phase === 'none' && (
        <p className="status thread-status">
          No existing DM conversation with @{handle} —{' '}
          <a href={`https://x.com/${handle}`} target="_blank" rel="noreferrer">start one on X</a> and it appears here.
        </p>
      )}
      {thread.phase === 'error' && <p className="status error thread-status">{thread.message}</p>}

      {thread.phase === 'loaded' && (
        <div className="thread-messages" ref={scrollRef}>
          {thread.messages.length === 0 && <p className="status">Thread is empty.</p>}
          {thread.messages.map((m, i) => (
            <div key={i} className={`bubble ${m.from}`}>
              <span className="bubble-text">{m.text}</span>
              {m.time && <span className="bubble-time">{m.time}</span>}
            </div>
          ))}
        </div>
      )}

      <form
        className="thread-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          placeholder={`Message @${handle}…`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={sending || thread.phase === 'none'}
        />
        <button type="submit" disabled={sending || !draft.trim() || thread.phase === 'none'}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </form>
      <p className="fine thread-note">
        Messages go through X's own client in your x.com tab — OpenSession servers never see them.
      </p>
    </div>
  );
}
