/**
 * Desktop threads client: same API and types as the web app's
 * app/src/lib/threads.ts, but calls go through the Electron main process
 * (window.desktop.apiFetch) because the renderer's file:// origin is not
 * on the gateway's CORS allowlist.
 */
import { sanitize } from '../../scan/leakscan.mjs';
import type { NewThread, Post, Thread } from '@oslib/threads';

export type { NewThread, Post, Thread };

async function call<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await window.desktop.apiFetch(method, path, token, body);
  if (!res.ok) {
    const d = res.data as { error?: string; error_description?: string };
    throw new Error(d.error_description ?? d.error ?? `threads API ${res.status}`);
  }
  return res.data as T;
}

export class DesktopThreadsClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  async list(repo?: string): Promise<Thread[]> {
    const qs = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    return (await call<{ threads: Thread[] }>(this.token, 'GET', `/threads${qs}`)).threads;
  }

  async get(id: string): Promise<{ thread: Thread; posts: Post[] }> {
    return call(this.token, 'GET', `/threads/${id}`);
  }

  async create(t: NewThread): Promise<Thread> {
    // Sanitize the turn excerpt before it lands in our store: strip encrypted
    // reasoning envelopes and redact secrets the model's own pass may miss.
    const payload = { ...t, turn_excerpt: sanitize(t.turn_excerpt).text };
    const thread = (await call<{ thread: Thread }>(this.token, 'POST', '/threads', payload)).thread;
    markEngaged(thread.id);
    return thread;
  }

  async reply(threadId: string, text: string, parentId?: string): Promise<Post> {
    const post = (
      await call<{ post: Post }>(this.token, 'POST', `/threads/${threadId}/posts`, {
        text,
        ...(parentId ? { parent_id: parentId } : {}),
      })
    ).post;
    markEngaged(threadId);
    return post;
  }

  async vote(threadId: string, value: -1 | 0 | 1, postId?: string): Promise<{ my_vote: number; score?: number }> {
    const r = await call<{ my_vote: number; score?: number }>(this.token, 'PUT', '/vote', {
      thread_id: threadId,
      value,
      ...(postId ? { post_id: postId } : {}),
    });
    markEngaged(threadId);
    return r;
  }
}

// ── engaged threads (created / replied / voted), tracked locally ──

const ENGAGED_KEY = 'opensession.desktop.engaged-threads';

export function engagedThreadIds(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(ENGAGED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function markEngaged(id: string): void {
  const ids = engagedThreadIds();
  ids.add(id);
  localStorage.setItem(ENGAGED_KEY, JSON.stringify([...ids]));
}
