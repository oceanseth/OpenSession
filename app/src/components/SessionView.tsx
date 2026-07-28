import { useCallback, useEffect, useMemo, useState } from 'react';
import { hasBrowserLlm, suggestThreadTitle } from '../lib/llm';
import {
  speakerOf,
  type MessageRecord,
  type ParsedArchive,
  type ParsedSession,
} from '../lib/opensession';
import { ThreadsClient, type Thread } from '../lib/threads';

interface SessionViewProps {
  title: string; // owner/repo when opened from the feed or a github URL
  archive: ParsedArchive;
  sourceUrl?: string;
  token?: string;
  onBack: () => void;
  onOpenThread?: (threadId: string) => void;
}

export function SessionView({ title, archive, sourceUrl, token, onBack, onOpenThread }: SessionViewProps) {
  const threadsClient = useMemo(() => (token ? new ThreadsClient(token) : null), [token]);
  const [threadsByTurn, setThreadsByTurn] = useState<Map<string, Thread[]>>(new Map());
  const isRepo = /^[\w.-]+\/[\w.-]+$/.test(title);

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
    <div className="session-view">
      <div className="session-toolbar">
        <button className="ghost" onClick={onBack}>← back</button>
        <h2>{title}</h2>
        {sourceUrl && (
          <a href={sourceUrl} target="_blank" rel="noreferrer" className="source-link">
            source ↗
          </a>
        )}
      </div>

      {archive.header?.preface && <p className="preface">“{archive.header.preface}”</p>}

      {archive.errors.length > 0 && (
        <p className="status error">
          {archive.errors.length} line{archive.errors.length > 1 ? 's' : ''} failed to parse (first at line{' '}
          {archive.errors[0].line}).
        </p>
      )}

      {archive.sessions.length === 0 && <p className="status">No session records in this archive.</p>}

      {archive.sessions.map((s, i) => (
        <Session
          key={i}
          session={s}
          repo={isRepo ? title : undefined}
          threadsClient={threadsClient}
          threadsByTurn={threadsByTurn}
          onThreadCreated={loadThreads}
          onOpenThread={onOpenThread}
        />
      ))}
    </div>
  );
}

interface SessionProps {
  session: ParsedSession;
  repo?: string;
  threadsClient: ThreadsClient | null;
  threadsByTurn: Map<string, Thread[]>;
  onThreadCreated: () => void;
  onOpenThread?: (threadId: string) => void;
}

function Session({ session, repo, threadsClient, threadsByTurn, onThreadCreated, onOpenThread }: SessionProps) {
  const { speakers } = session.session;
  const attested = new Set(session.identities.map((r) => r.identity));
  return (
    <section className="session card">
      <header className="session-head">
        <span className="session-date">{session.session.session || 'undated session'}</span>
        {session.session.tool && <span className="session-tool">{session.session.tool}</span>}
        <span className="speakers">
          {Object.entries(speakers).map(([abbrev, sp]) => (
            <span key={abbrev} className={`speaker-chip ${sp.kind}`}>
              {sp.name ?? abbrev}
              {sp.kind === 'model' && sp.id ? ` (${sp.id})` : ''}
              {attested.has(abbrev) && <span title="identity attested"> ✓</span>}
            </span>
          ))}
        </span>
      </header>
      {session.identities.length > 0 && (
        <p className="identities">
          {session.identities.map((r, i) => (
            <span key={i} className="identity-chip" title={JSON.stringify(r, null, 2)}>
              {String(r.github ?? r.identity)} attested via {r.method}
            </span>
          ))}
        </p>
      )}
      <div className="turns">
        {session.messages.map((m) => (
          <Turn
            key={m.id}
            session={session}
            msg={m}
            repo={repo}
            threadsClient={threadsClient}
            threads={threadsByTurn.get(m.id) ?? []}
            onThreadCreated={onThreadCreated}
            onOpenThread={onOpenThread}
          />
        ))}
      </div>
    </section>
  );
}

interface TurnProps {
  session: ParsedSession;
  msg: MessageRecord;
  repo?: string;
  threadsClient: ThreadsClient | null;
  threads: Thread[];
  onThreadCreated: () => void;
  onOpenThread?: (threadId: string) => void;
}

function Turn({ session, msg, repo, threadsClient, threads, onThreadCreated, onOpenThread }: TurnProps) {
  const [expanded, setExpanded] = useState(false);
  const [discussing, setDiscussing] = useState(false);
  const speaker = speakerOf(session, msg);
  const kind = speaker?.kind ?? 'human';
  const long = msg.t.length > 1200;
  const text = long && !expanded ? msg.t.slice(0, 1200) + '…' : msg.t;
  const canDiscuss = !!threadsClient && !!repo;

  return (
    <article className={`turn ${kind}`}>
      <div className="turn-meta">
        <span className="turn-speaker">{speaker?.name ?? msg.m}</span>
        {msg.ts && <time dateTime={msg.ts}>{formatTs(msg.ts)}</time>}
        <span className="turn-actions">
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
      <div className="turn-body">{text}</div>
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
          speakerName={speaker?.name ?? msg.m}
          onDone={(threadId) => {
            setDiscussing(false);
            onThreadCreated();
            onOpenThread?.(threadId);
          }}
        />
      )}
    </article>
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
