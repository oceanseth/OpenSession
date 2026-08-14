import { useCallback, useEffect, useState } from 'react';
import { DesktopThreadsClient, type Post, type Thread } from '../lib/threads';

export type ThreadView =
  | { kind: 'global' }
  | { kind: 'detail'; id: string }
  | {
      kind: 'new';
      repo: string;
      turn: { id: string; ts?: string; speaker?: string; excerpt: string };
    };

function age(created: number): string {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - created));
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Right-rail discussions: global thread list, one thread's posts, or a composer. */
export function ThreadPanel({
  client,
  view,
  onView,
  onClose,
  onThreadsChanged,
}: {
  client: DesktopThreadsClient;
  view: ThreadView;
  onView: (v: ThreadView) => void;
  onClose: () => void;
  onThreadsChanged: (repo: string) => void;
}) {
  const [threads, setThreads] = useState<Thread[]>();
  const [detail, setDetail] = useState<{ thread: Thread; posts: Post[] }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [reply, setReply] = useState('');

  const refreshDetail = useCallback(
    (id: string) => {
      setDetail(undefined);
      setError(undefined);
      client
        .get(id)
        .then(setDetail)
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    },
    [client],
  );

  useEffect(() => {
    setError(undefined);
    if (view.kind === 'global') {
      setThreads(undefined);
      client
        .list()
        .then(setThreads)
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    } else if (view.kind === 'detail') {
      refreshDetail(view.id);
    }
  }, [client, refreshDetail, view]);

  const createThread = async () => {
    if (view.kind !== 'new' || !title.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const t = await client.create({
        repo: view.repo,
        turn_id: view.turn.id,
        turn_ts: view.turn.ts,
        turn_speaker: view.turn.speaker,
        turn_excerpt: view.turn.excerpt,
        title: title.trim(),
        description: description.trim(),
      });
      setTitle('');
      setDescription('');
      onThreadsChanged(view.repo);
      onView({ kind: 'detail', id: t.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const sendReply = async () => {
    if (view.kind !== 'detail' || !reply.trim() || !detail) return;
    setBusy(true);
    try {
      await client.reply(detail.thread.id, reply.trim());
      setReply('');
      onThreadsChanged(detail.thread.repo);
      refreshDetail(detail.thread.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const voteThread = async (value: -1 | 0 | 1) => {
    if (!detail) return;
    try {
      const next = detail.thread.my_vote === value ? 0 : value;
      const r = await client.vote(detail.thread.id, next);
      setDetail({
        ...detail,
        thread: {
          ...detail.thread,
          my_vote: r.my_vote as -1 | 0 | 1,
          score: r.score ?? detail.thread.score,
        },
      });
      onThreadsChanged(detail.thread.repo);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <aside className="thread-panel">
      <header className="panel-head">
        <h3>
          {view.kind === 'global' && 'Threads'}
          {view.kind === 'detail' && 'Discussion'}
          {view.kind === 'new' && 'New discussion'}
        </h3>
        <span className="row">
          {view.kind !== 'global' && (
            <button className="icon-btn" onClick={() => onView({ kind: 'global' })} title="All threads">
              ☰
            </button>
          )}
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </span>
      </header>

      {error && <p className="status error">{error}</p>}

      {view.kind === 'global' && (
        <div className="thread-list">
          {!threads && !error && <p className="status">Loading…</p>}
          {threads?.length === 0 && <p className="status">No threads yet — start one from any turn.</p>}
          {threads?.map((t) => (
            <button key={t.id} className="thread-item" onClick={() => onView({ kind: 'detail', id: t.id })}>
              <strong>{t.title}</strong>
              <span className="thread-meta">
                {t.repo} · {t.reply_count} repl{t.reply_count === 1 ? 'y' : 'ies'} · score {t.score} ·{' '}
                {age(t.created_at)} ago
              </span>
              <em className="thread-excerpt">“{t.turn_excerpt}”</em>
            </button>
          ))}
        </div>
      )}

      {view.kind === 'detail' && detail && (
        <div className="thread-detail">
          <div className="thread-title-row">
            <div className="vote-col">
              <button
                className={`icon-btn${detail.thread.my_vote === 1 ? ' voted' : ''}`}
                onClick={() => void voteThread(1)}
              >
                ▲
              </button>
              <span>{detail.thread.score}</span>
              <button
                className={`icon-btn${detail.thread.my_vote === -1 ? ' voted' : ''}`}
                onClick={() => void voteThread(-1)}
              >
                ▼
              </button>
            </div>
            <div>
              <strong>{detail.thread.title}</strong>
              <div className="thread-meta">
                {detail.thread.repo} · {detail.thread.creator.github_login} · {age(detail.thread.created_at)} ago
              </div>
              <em className="thread-excerpt">“{detail.thread.turn_excerpt}”</em>
              {detail.thread.description && <p className="thread-desc">{detail.thread.description}</p>}
            </div>
          </div>

          <div className="posts">
            {detail.posts.map((p) => (
              <div key={p.id} className="post">
                <span className="post-author">{p.author.github_login}</span>
                <span className="ts">{age(p.created_at)} ago</span>
                <div className="post-text">{p.text}</div>
              </div>
            ))}
            {detail.posts.length === 0 && <p className="status">No replies yet.</p>}
          </div>

          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void sendReply();
            }}
          >
            <input placeholder="Reply…" value={reply} onChange={(e) => setReply(e.target.value)} />
            <button type="submit" className="primary" disabled={busy || !reply.trim()}>
              Send
            </button>
          </form>
        </div>
      )}

      {view.kind === 'new' && (
        <div className="thread-new">
          <em className="thread-excerpt">“{view.turn.excerpt}”</em>
          <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea
            placeholder="What's worth discussing about this turn?"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <button className="primary" disabled={busy || !title.trim()} onClick={() => void createThread()}>
            Start discussion
          </button>
        </div>
      )}
    </aside>
  );
}
