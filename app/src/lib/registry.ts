/**
 * Client for the OpenSession registry API — the server-side cache of repos
 * known to implement the Open Session License (canonical key: GitHub repo id,
 * server-verified at most once daily). Auth: the user's GitHub token.
 */

const API = 'https://r1q8b3li40.execute-api.us-east-1.amazonaws.com/api';

export interface RegistryRepo {
  id: number;
  full_name: string;
  status: 'active' | 'no-license' | 'pending';
  history_sha: string | null;
  history_size: number | null;
  last_checked_at: number | null;
  last_changed_at: number | null;
  followedAt?: number;
}

export interface MatchResult {
  known: RegistryRepo[];
  queued: number;
}

/** Normalize user input ("owner/name", github.com URL, .git suffix) to "owner/name". */
export function parseRepoInput(input: string): string | null {
  const m = input
    .trim()
    .match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/);
  if (!m || m[1] === '..' || m[2] === '..') return null;
  return `${m[1]}/${m[2]}`;
}

export class RegistryClient {
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
      throw new Error(d.error_description ?? d.error ?? `registry API ${res.status}`);
    }
    return data as T;
  }

  /** Which of these repos are known license implementers? Queues the rest for verification. */
  async match(repos: { id: number; full_name: string }[]): Promise<MatchResult> {
    const result: MatchResult = { known: [], queued: 0 };
    for (let i = 0; i < repos.length; i += 1000) {
      const batch = await this.call<MatchResult>('POST', '/repos/match', { repos: repos.slice(i, i + 1000) });
      result.known.push(...batch.known);
      result.queued += batch.queued;
    }
    return result;
  }

  /** Submit a repo by name/URL; server verifies and auto-follows on success. */
  submit(repo: string): Promise<{ repo: RegistryRepo; followed: boolean }> {
    return this.call('POST', '/repos/submit', { repo });
  }

  async follows(): Promise<RegistryRepo[]> {
    return (await this.call<{ follows: RegistryRepo[] }>('GET', '/follows')).follows;
  }

  follow(id: number, fullName: string): Promise<void> {
    return this.call('PUT', `/follows/${id}`, { full_name: fullName });
  }

  unfollow(id: number): Promise<void> {
    return this.call('DELETE', `/follows/${id}`);
  }
}
