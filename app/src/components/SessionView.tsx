import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GitHubClient } from '../lib/github';
import { hasBrowserLlm, suggestThreadTitle } from '../lib/llm';
import {
  sessionLabel,
  speakerOf,
  type MessageRecord,
  type ParsedArchive,
  type ParsedSession,
} from '../lib/opensession';
import type { Identity } from '../lib/identity';
import { ThreadsClient, type Thread } from '../lib/threads';
import type { XChatConnector } from '../lib/xchat';
import { DmPopup } from './DmPopup';

interface SessionViewProps {
  title: string; // owner/repo when opened from the feed or a github URL
  archive: ParsedArchive;
  sourceUrl?: string;
  token?: string;
  client: GitHubClient;
  connector: XChatConnector;
  myIdentity?: Identity | null;
  onBack: () => void;
  onOpenThread?: (threadId: string) => void;
}

/**
 * Slack-style session browser: sessions/channels down the left rail, the
 * selected session's turns as a chat transcript on the right, clickable
 * speaker names opening a quick-DM popup.
 */
export function SessionView({ title, archive, sourceUrl, token, client, connector, myIdentity, onBack, onOpenThread }: SessionViewProps) {
  const threadsClient = useMemo(() => (token ? new ThreadsClient(token) : null), [token]);
  const [threadsByTurn, setThreadsByTurn] = useState<Map<string, Thread[]>>(new Map());
  const [selected, setSelected] = useState(() => Math.max(0, archive.sessions.length - 1));
  const [dmLogin, setDmLogin] = useState<string>();
  const isRepo = /^[\w.-]+\/[\w.-]+$/.test(title);
  const session = archive.sessions[selected];

  const loadThreads = useCallback(async () => {
    if (!threadsClient || !isRepo) return;
    try {
      const list = await threadsClient.list(title);
      const map = new Map<string, Thread[]>();
      for (const t of list) {
        const cur = map.get(t.turn_id) ?? [];
        cur.push(t);
        map.set(t.turn_id, cur);
      }
      setThreadsByTurn(map);
    } catch {
      /* threads are an overlay — the session still renders */
    }
  }, [threadsClient, isRepo, title]);

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  return (
    <div className="slack">
      <aside className="slack-side">
        <header className="slack-side-head">
          <button className="ghost" onClick={onBack}>←</button>
          <span className="slack-repo" title={title}>{title}</span>
        </header>
        {sourceUrl && (
          <a href={sourceUrl} target="_blank" rel="noreferrer" className="slack-source fine">
            raw history ↗
          </a>
        )}
        <div className="slack-side-label">
          Sessions <span className="fine">{archive.sessions.length}</span>
        </div>
        <ul className="slack-channels">
          {archive.sessions.map((s, i) => (
            <li key={s.session.sid ?? i}>
              <button
                className={i === selected ? 'slack-channel active' : 'slack-channel'}
                title={s.session.sid}
                onClick={() => setSelected(i)}
              >
                <span className="hash">#</span>
                <span className="slack-channel-name">{sessionLabel(s, i)}</span>
                <span className="channel-count">{s.messages.length}</span>
              </button>
            </li>
          ))}
        </ul>
        {archive.errors.length > 0 && (
          <p className="status error slack-errors">
            {archive.errors.length} unparseable line{archive.errors.length > 1 ? 's' : ''}
          </p>
        )}
      </aside>

      <section className="slack-main">
        {session ? (
          <>
            <header className="slack-main-head">
              <span className="slack-title">
                <span className="hash">#</span> {sessionLabel(session, selected)}
              </span>
              <span className="fine">{session.session.session}</span>
              {session.session.tool && <span className="session-tool">{session.session.tool}</span>}
              {session.session.sid && (
                <code className="session-sid" title={`session id ${session.session.sid}`}>
                  {session.session.sid.slice(0, 10)}…
                </code>
              )}
              <span className="speakers">
                {Object.entries(session.session.speakers).map(([abbrev, sp]) => (
                  <span key={abbrev} className={`speaker-chip ${sp.kind}`}>
                    {sp.name ?? abbrev}
                    {session.identities.some((r) => r.identity === abbrev) && <span title="identity attested"> ✓</span>}
                  </span>
                ))}
              </span>
            </header>
            <div className="slack-msgs">
              {session.messages.map((m) => (
                <Msg
                  key={m.id}
                  session={session}
                  msg={m}
                  repo={isRepo ? title : undefined}
                  threadsClient={threadsClient}
                  threads={threadsByTurn.get(m.id) ?? []}
                  onThreadCreated={loadThreads}
                  onOpenThread={onOpenThread}
                  onOpenDm={token ? setDmLogin : undefined}
                />
              ))}
              {session.messages.length === 0 && <p className="status">No turns recorded in this session.</p>}
            </div>
          </>
        ) : (
          <p className="status slack-empty">No session records in this archive.</p>
        )}
      </section>

      {dmLogin && token && (
        <DmPopup
          login={dmLogin}
          client={client}
          token={token}
          connector={connector}
          myIdentity={myIdentity}
          onClose={() => setDmLogin(undefined)}
        />
      )}
    </div>
  );
}

interface MsgProps {
  session: ParsedSession;
  msg: MessageRecord;
  repo?: string;
  threadsClient: ThreadsClient | null;
  threads: Thread[];
  onThreadCreated: () => void;
  onOpenThread?: (threadId: string) => void;
  onOpenDm?: (login: string) => void;
}

function Msg({ session, msg, repo, threadsClient, threads, onThreadCreated, onOpenThread, onOpenDm }: MsgProps) {
  const [expanded, setExpanded] = useState(false);
  const [discussing, setDiscussing] = useState(false);
  const speaker = speakerOf(session, msg);
  const kind = speaker?.kind ?? 'human';
  const name = speaker?.name ?? msg.m;
  const github = speaker?.github;
  const long = msg.t.length > 1200;
  const text = long && !expanded ? msg.t.slice(0, 1200) + '…' : msg.t;
  const canDiscuss = !!threadsClient && !!repo;

  return (
    <div className="msg">
      <div className={`msg-avatar ${kind}`}>{name.slice(0, 1).toUpperCase()}</div>
      <div className="msg-body">
        <div className="msg-head">
          {github && onOpenDm ? (
            <button className={`msg-user ${kind} clickable`} title={`DM ${github}`} onClick={() => onOpenDm(github)}>
              {name}
            </button>
          ) : (
            <span className={`msg-user ${kind}`}>{name}</span>
          )}
          {msg.ts && <time dateTime={msg.ts}>{formatTs(msg.ts)}</time>}
          <span className="msg-actions">
            {threads.length > 0 && (
              <button
                className="thread-badge"
                title={threads.map((t) => t.title).join('\n')}
                onClick={() => onOpenThread?.(threads[0].id)}
              >
                💬 {threads.length}
              </button>
            )}
            {canDiscuss && (
              <button className="linklike" onClick={() => setDiscussing(!discussing)}>
                {discussing ? 'cancel' : '+ thread'}
              </button>
            )}
          </span>
        </div>
        <div className="msg-text">{text}</div>
        {long && (
          <button className="ghost expand" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'show less' : `show all ${msg.t.length.toLocaleString()} chars`}
          </button>
        )}
        {msg.x && <div className="turn-tools">⚙ {msg.x}</div>}
        {discussing && canDiscuss && (
          <CreateThreadForm
            client={threadsClient!}
            repo={repo!}
            msg={msg}
            speakerName={name}
            onDone={(threadId) => {
              setDiscussing(false);
              onThreadCreated();
              onOpenThread?.(threadId);
            }}
          />
        )}
      </div>
    </div>
  );
}

function CreateThreadForm({
  client,
  repo,
  msg,
  speakerName,
  onDone,
}: {
  client: ThreadsClient;
  repo: string;
  msg: MessageRecord;
  speakerName: string;
  onDone: (threadId: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [llmAvailable, setLlmAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // If an in-browser LLM is available, offer (and auto-run) a title suggestion.
  useEffect(() => {
    let cancelled = false;
    void hasBrowserLlm().then((ok) => {
      if (cancelled || !ok) return;
      setLlmAvailable(true);
      setSuggesting(true);
      void suggestThreadTitle(msg.t).then((s) => {
        if (!cancelled) {
          setSuggesting(false);
          if (s) setTitle((cur) => cur || s);
        }
      });
    });
    return () => {
      cancelled = true;
    };
  }, [msg.t]);

  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const thread = await client.create({
        repo,
        turn_id: msg.id,
        turn_ts: msg.ts,
        turn_speaker: speakerName,
        turn_excerpt: msg.t.slice(0, 280),
        title: title.trim(),
        description: description.trim(),
      });
      onDone(thread.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="create-thread card"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="token-entry">
        <input
          placeholder={suggesting ? 'Thinking of a title…' : 'Enter thread title'}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={140}
          disabled={busy}
        />
        {llmAvailable && (
          <button
            type="button"
            className="ghost"
            disabled={suggesting || busy}
            onClick={() => {
              setSuggesting(true);
              void suggestThreadTitle(msg.t).then((s) => {
                setSuggesting(false);
                if (s) setTitle(s);
              });
            }}
          >
            {suggesting ? '…' : 'Suggest'}
          </button>
        )}
      </div>
      <textarea
        placeholder="What do you want to discuss about this turn? (shown when the thread is opened)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={3}
        maxLength={5000}
        disabled={busy}
      />
      <div className="token-entry">
        <button type="submit" disabled={busy || !title.trim()}>
          {busy ? 'Creating…' : 'Create thread'}
        </button>
      </div>
      {error && <p className="status error">{error}</p>}
    </form>
  );
}

function formatTs(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
