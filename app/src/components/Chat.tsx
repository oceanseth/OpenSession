import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Contributor, GitHubClient } from '../lib/github';
import { IdentityClient, type Identity } from '../lib/identity';
import { RegistryClient } from '../lib/registry';

const REFRESH_MS = 120_000;

/** A contributor across followed repos, with their linked X identity (if any). */
interface Person extends Contributor {
  repos: string[];
  identity?: Identity;
}

interface ChatProps {
  client: GitHubClient;
  token: string;
  myIdentity: Identity | null;
}

export function Chat({ client, token, myIdentity }: ChatProps) {
  const registry = useMemo(() => new RegistryClient(token), [token]);
  const identityClient = useMemo(() => new IdentityClient(token), [token]);
  const [people, setPeople] = useState<Person[]>([]);
  const [selected, setSelected] = useState<number>();
  const [status, setStatus] = useState<string>('Loading contributors…');

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
      // Linked contributors first, then by recency of activity.
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
          <span className="fine">{people.filter((p) => p.identity).length} on X</span>
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
        {person ? (
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
                <a
                  className="dm-button"
                  href={`https://x.com/${person.identity.x_handle}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Message @{person.identity.x_handle} on X
                </a>
                <p className="fine">
                  Opens their X profile — hit the DM button there. With the{' '}
                  <a href="https://github.com/oceanseth/xChatHub" target="_blank" rel="noreferrer">xChatHub</a>{' '}
                  extension installed, x.com messages become a keyboard-first, full-screen client.
                  {person.identity.method === 'claimed' && ' (Handle is self-reported, not yet extension-verified.)'}
                </p>
              </>
            ) : (
              <p className="status">
                {person.login} hasn't linked an X account on OpenSession yet — you can still reach them through their
                GitHub profile.
              </p>
            )}
          </div>
        ) : (
          <div className="chat-empty">
            <p>
              {myIdentity
                ? `You're linked as @${myIdentity.x_handle}. Select a contributor to message them on X.`
                : 'Select a contributor to see their linked X identity.'}
            </p>
            <p className="fine">
              In-page DMs (without leaving OpenSession) are coming via the xChatHub extension bridge — this tab will
              become the conversation view.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
