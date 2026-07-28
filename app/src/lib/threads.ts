/** Client for the discussion-threads API — a Reddit layer over session turns. */

const API = import.meta.env.DEV ? 'https://r1q8b3li40.execute-api.us-east-1.amazonaws.com/api' : '/api';

export interface ThreadCreator {
  github_id: number;
  github_login: string;
  x_handle: string | null;
}

export interface Thread {
  id: string;
  repo: string;
  turn_id: string;
  turn_ts: string | null;
  turn_speaker: string | null;
  turn_excerpt: string;
  title: string;
  description: string;
  creator: ThreadCreator;
  created_at: number;
  score: number;
  reply_count: number;
  my_vote: -1 | 0 | 1;
}

export interface Post {
  id: string;
  parent_id: string | null;
  text: string;
  author: ThreadCreator;
  created_at: number;
  score: number;
  my_vote: -1 | 0 | 1;
}

export interface NewThread {
  repo: string;
  turn_id: string;
  turn_ts?: string;
  turn_speaker?: string;
  turn_excerpt: string;
  title: string;
  description: string;
}

export class ThreadsClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const d = data as { error?: string; error_description?: string };
      throw new Error(d.error_description ?? d.error ?? `threads API ${res.status}`);
    }
    return data as T;
  }

  async list(repo?: string): Promise<Thread[]> {
    const qs = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    return (await this.call<{ threads: Thread[] }>('GET', `/threads${qs}`)).threads;
  }

  async get(id: string): Promise<{ thread: Thread; posts: Post[] }> {
    return this.call('GET', `/threads/${id}`);
  }

  async create(t: NewThread): Promise<Thread> {
    return (await this.call<{ thread: Thread }>('POST', '/threads', t)).thread;
  }

  async reply(threadId: string, text: string, parentId?: string): Promise<Post> {
    return (
      await this.call<{ post: Post }>('POST', `/threads/${threadId}/posts`, {
        text,
        ...(parentId ? { parent_id: parentId } : {}),
      })
    ).post;
  }

  async vote(threadId: string, value: -1 | 0 | 1, postId?: string): Promise<{ my_vote: number; score?: number }> {
    return this.call('PUT', '/vote', { thread_id: threadId, value, ...(postId ? { post_id: postId } : {}) });
  }
}
