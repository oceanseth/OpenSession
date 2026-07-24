/**
 * GitHub client for the OpenSession feed: find starred repos that carry an
 * llm-turn-history.jsonl, and poll for changes to it.
 *
 * v0 runs entirely client-side against api.github.com with an optional
 * personal access token (unauthenticated works but is rate-limited to
 * 60 req/hr). Later this moves behind a backend with webhooks.
 */

const API = 'https://api.github.com';
export const HISTORY_FILE = 'llm-turn-history.jsonl';

export interface Repo {
  full_name: string; // "owner/name"
  description: string | null;
  default_branch: string;
  html_url: string;
  stargazers_count: number;
  pushed_at: string;
}

export interface SessionRepo {
  repo: Repo;
  /** Blob sha of the history file — changes whenever the file changes. */
  historySha: string;
  historySize: number;
  rawUrl: string;
  lastCommit?: HistoryCommit;
}

export interface HistoryCommit {
  sha: string;
  message: string;
  author: string | null;
  authorLogin: string | null;
  avatarUrl: string | null;
  date: string;
  htmlUrl: string;
}

export class GitHubClient {
  private token?: string;

  constructor(token?: string) {
    this.token = token;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
    });
    if (!res.ok) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (res.status === 403 && remaining === '0') {
        throw new Error('GitHub rate limit exceeded — add a personal access token to raise it.');
      }
      throw new Error(`GitHub ${res.status} on ${path}`);
    }
    return res.json() as Promise<T>;
  }

  async viewer(): Promise<{ login: string; avatar_url: string } | null> {
    if (!this.token) return null;
    return this.get('/user');
  }

  async starredRepos(perPage = 100, maxPages = 3): Promise<Repo[]> {
    const path = this.token ? '/user/starred' : null;
    if (!path) return [];
    const all: Repo[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.get<Repo[]>(`${path}?per_page=${perPage}&page=${page}&sort=updated`);
      all.push(...batch);
      if (batch.length < perPage) break;
    }
    return all;
  }

  async starredReposOf(login: string, perPage = 100, maxPages = 3): Promise<Repo[]> {
    const all: Repo[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.get<Repo[]>(
        `/users/${encodeURIComponent(login)}/starred?per_page=${perPage}&page=${page}&sort=updated`,
      );
      all.push(...batch);
      if (batch.length < perPage) break;
    }
    return all;
  }

  /** Does this repo ship a session history? Returns feed metadata if so. */
  async probeSessionFile(repo: Repo): Promise<SessionRepo | null> {
    try {
      const contents = await this.get<{ sha: string; size: number; download_url: string }>(
        `/repos/${repo.full_name}/contents/${HISTORY_FILE}?ref=${encodeURIComponent(repo.default_branch)}`,
      );
      return {
        repo,
        historySha: contents.sha,
        historySize: contents.size,
        rawUrl: contents.download_url,
      };
    } catch {
      return null; // 404 → repo doesn't carry a history file
    }
  }

  /** Most recent commit touching the history file (who appended last, and when). */
  async lastHistoryCommit(fullName: string): Promise<HistoryCommit | undefined> {
    interface CommitEntry {
      sha: string;
      html_url: string;
      commit: { message: string; author: { name: string; date: string } | null };
      author: { login: string; avatar_url: string } | null;
    }
    const commits = await this.get<CommitEntry[]>(
      `/repos/${fullName}/commits?path=${HISTORY_FILE}&per_page=1`,
    );
    const c = commits[0];
    if (!c) return undefined;
    return {
      sha: c.sha,
      message: c.commit.message.split('\n')[0],
      author: c.commit.author?.name ?? null,
      authorLogin: c.author?.login ?? null,
      avatarUrl: c.author?.avatar_url ?? null,
      date: c.commit.author?.date ?? '',
      htmlUrl: c.html_url,
    };
  }

  async fetchHistoryFile(fullName: string, branch: string): Promise<string> {
    const res = await fetch(
      `https://raw.githubusercontent.com/${fullName}/${encodeURIComponent(branch)}/${HISTORY_FILE}`,
    );
    if (!res.ok) throw new Error(`raw fetch ${res.status} for ${fullName}`);
    return res.text();
  }
}

/**
 * Scan starred repos for session files. Probes run in small batches to stay
 * inside rate limits; onProgress fires as each hit lands so the feed fills in
 * live rather than all at once.
 */
export async function scanForSessionRepos(
  client: GitHubClient,
  repos: Repo[],
  onProgress?: (found: SessionRepo, scanned: number, total: number) => void,
): Promise<SessionRepo[]> {
  const found: SessionRepo[] = [];
  const BATCH = 10;
  let scanned = 0;
  for (let i = 0; i < repos.length; i += BATCH) {
    const batch = repos.slice(i, i + BATCH);
    const results = await Promise.all(batch.map((r) => client.probeSessionFile(r)));
    scanned += batch.length;
    for (const hit of results) {
      if (hit) {
        found.push(hit);
        onProgress?.(hit, scanned, repos.length);
      }
    }
  }
  return found;
}
