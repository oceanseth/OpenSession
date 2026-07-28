import { useCallback, useEffect, useMemo, useState } from 'react';
import { ThreadsClient, type Post, type Thread } from '../lib/threads';

interface ThreadsProps {
  token: string;
  /** Thread to auto-expand (e.g. arriving from a session turn's badge). */
  initialThreadId?: string;
  onOpenSession?: (repo: string) => void;
}

export function Threads({ token, initialThreadId, onOpenSession }: ThreadsProps) {
  const client = useMemo(() => new ThreadsClient(token), [token]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [expanded, setExpanded] = useState<string | undefined>(initialThreadId);
  const [status, setStatus] = useState<string>('Loading threads…');

  const load = useCallback(async () => {
    try {
      const list = await client.list();
      setThreads(list);
      setStatus(list.length === 0 ? 'No threads yet — open a session in the Activity tab and hit “discuss” on any turn.' : '');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const voteThread = async (t: Thread, dir: -1 | 1) => {
    const value = t.my_vote === dir ? 0 : dir;
    setThreads((cur) =>
      cur.map((x) => (x.id === t.id ? { ...x, my_vote: value, score: x.score + value - t.my_vote } : x)),
    );
    try {
      await client.vote(t.id, value);
    } catch {
      void load(); // resync on failure
    }
  };

  return (
    <div className="threads">
      {status && <p className="status">{status}</p>}
      <ul className="thread-list">
        {threads.map((t) => (
          <li key={t.id} className="card thread-item">
            <div className="vote-col">
              <button className={t.my_vote === 1 ? 'vote active' : 'vote'} onClick={() => void voteThread(t, 1)} title="upvote">
                ▲
              </button>
              <span className="score">{t.score}</span>
              <button className={t.my_vote === -1 ? 'vote active down' : 'vote'} onClick={() => void voteThread(t, -1)} title="downvote">
                ▼
              </button>
            </div>
            <div className="thread-main">
              <button className="thread-title" onClick={() => setExpanded(expanded === t.id ? undefined : t.id)}>
                {t.title}
              </button>
              <p className="thread-meta">
                by{' '}
                {t.creator.x_handle ? (
                  <a href={`https://x.com/${t.creator.x_handle}`} target="_blank" rel="noreferrer">
                    @{t.creator.x_handle}
                  </a>
                ) : (
                  <a href={`https://github.com/${t.creator.github_login}`} target="_blank" rel="noreferrer">
                    {t.creator.github_login}
                  </a>
                )}{' '}
                · {timeAgo(t.created_at)} · {t.reply_count} repl{t.reply_count === 1 ? 'y' : 'ies'} · on{' '}
                {onOpenSession ? (
                  <button className="linklike" onClick={() => onOpenSession(t.repo)}>{t.repo}</button>
                ) : (
                  t.repo
                )}
                {t.turn_speaker && <> · turn by {t.turn_speaker}</>}
              </p>
              <blockquote className="turn-quote">“{t.turn_excerpt}”</blockquote>
              {expanded === t.id && <ThreadDetail client={client} threadId={t.id} description={t.description} />}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ThreadDetail({ client, threadId, description }: { client: ThreadsClient; threadId: string; description: string }) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [status, setStatus] = useState<string>('Loading discussion…');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await client.get(threadId);
      setPosts(r.posts);
      setStatus('');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }, [client, threadId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (text: string, parentId?: string) => {
    setBusy(true);
    try {
      await client.reply(threadId, text, parentId);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const votePost = async (p: Post, dir: -1 | 1) => {
    const value = p.my_vote === dir ? 0 : dir;
    setPosts((cur) => cur.map((x) => (x.id === p.id ? { ...x, my_vote: value, score: x.score + value - p.my_vote } : x)));
    try {
      await client.vote(threadId, value, p.id);
    } catch {
      void load();
    }
  };

  const topLevel = posts.filter((p) => !p.parent_id);
  const children = (id: string) => posts.filter((p) => p.parent_id === id);

  return (
    <div className="thread-detail">
      {description && <p className="thread-description">{description}</p>}
      {status && <p className="status">{status}</p>}
      <div className="post-tree">
        {topLevel.map((p) => (
          <PostNode key={p.id} post={p} childrenOf={children} onVote={votePost} onReply={submit} busy={busy} depth={0} />
        ))}
      </div>
      <form
        className="post-composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) {
            void submit(draft.trim()).then(() => setDraft(''));
          }
        }}
      >
        <input placeholder="Add to the discussion…" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={busy} />
        <button type="submit" disabled={busy || !draft.trim()}>Post</button>
      </form>
    </div>
  );
}

function PostNode({
  post,
  childrenOf,
  onVote,
  onReply,
  busy,
  depth,
}: {
  post: Post;
  childrenOf: (id: string) => Post[];
  onVote: (p: Post, dir: -1 | 1) => Promise<void>;
  onReply: (text: string, parentId?: string) => Promise<void>;
  busy: boolean;
  depth: number;
}) {
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState('');
  const kids = childrenOf(post.id);

  return (
    <div className={depth > 0 ? 'post nested' : 'post'}>
      <div className="post-head">
        <button className={post.my_vote === 1 ? 'vote mini active' : 'vote mini'} onClick={() => void onVote(post, 1)}>▲</button>
        <span className="score mini">{post.score}</span>
        <button className={post.my_vote === -1 ? 'vote mini active down' : 'vote mini'} onClick={() => void onVote(post, -1)}>▼</button>
        <span className="post-author">
          {post.author.x_handle ? (
            <a href={`https://x.com/${post.author.x_handle}`} target="_blank" rel="noreferrer">@{post.author.x_handle}</a>
          ) : (
            post.author.github_login
          )}
        </span>
        <span className="fine">{timeAgo(post.created_at)}</span>
        <button className="linklike" onClick={() => setReplying(!replying)}>
          {replying ? 'cancel' : 'reply'}
        </button>
      </div>
      <p className="post-text">{post.text}</p>
      {replying && (
        <form
          className="post-composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) {
              void onReply(draft.trim(), post.id).then(() => {
                setDraft('');
                setReplying(false);
              });
            }
          }}
        >
          <input autoFocus placeholder={`Reply…`} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={busy} />
          <button type="submit" disabled={busy || !draft.trim()}>Reply</button>
        </form>
      )}
      {kids.map((k) => (
        <PostNode key={k.id} post={k} childrenOf={childrenOf} onVote={onVote} onReply={onReply} busy={busy} depth={depth + 1} />
      ))}
    </div>
  );
}

function timeAgo(ms: number): string {
  const mins = Math.floor((Date.now() - ms) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days < 30 ? `${days}d ago` : new Date(ms).toLocaleDateString();
}
