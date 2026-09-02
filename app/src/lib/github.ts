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
  id: number; // GitHub numeric repo id — canonical key in the registry
  full_name: string; // "owner/name"
  description: string | null;
  default_branch: string;
  html_url: string;
  stargazers_count: number;
  pushed_at: string;
}

export interface Contributor {
  id: number; // GitHub user id — the key identities are linked under
  login: string;
  avatarUrl: string;
  lastActive: string; // ISO date of most recent history append
  commits: number;
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

  /**
   * Fetch a window of the user's starred repos (newest stars first).
   * Returns the repos plus whether more pages remain, so callers can offer
   * "scan more" instead of walking tens of thousands of stars up front.
   */
  async starredRepos(startPage = 1, maxPages = 10, perPage = 100): Promise<{ repos: Repo[]; more: boolean }> {
    if (!this.token) return { repos: [], more: false };
    const repos: Repo[] = [];
    for (let page = startPage; page < startPage + maxPages; page++) {
      const batch = await this.get<Repo[]>(`/user/starred?per_page=${perPage}&page=${page}`);
      repos.push(...batch);
      if (batch.length < perPage) return { repos, more: false };
    }
    return { repos, more: true };
  }

  /**
   * Is the signed-in user starring this repo? `null` when we can't tell —
   * signed out, rate-limited, or a token whose scopes don't cover starring.
   * Callers treat `null` as "don't ask", so a bad answer never nags anyone.
   */
  async isStarred(fullName: string): Promise<boolean | null> {
    if (!this.token) return null;
    try {
      const res = await fetch(`${API}/user/starred/${fullName}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
        },
      });
      if (res.status === 204) return true;
      if (res.status === 404) return false;
      // Some tokens can list stars but not query one directly — fall back to
      // the same starred window the feed already scans.
      const { repos, more } = await this.starredRepos(1, 3);
      if (repos.some((r) => r.full_name.toLowerCase() === fullName.toLowerCase())) return true;
      return more ? null : false; // beyond the scanned window we genuinely don't know
    } catch {
      return null;
    }
  }

  /** Live-probe a repo's history file on its default branch (sha changes = new turns). */
  async probeHistory(fullName: string): Promise<{ sha: string; size: number } | null> {
    try {
      const contents = await this.get<{ sha: string; size: number }>(
        `/repos/${fullName}/contents/${HISTORY_FILE}`,
      );
      return { sha: contents.sha, size: contents.size };
    } catch {
      return null; // 404 → file (or repo) gone
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

  /** GitHub numeric user id for a login (identity records are keyed by id). */
  async userIdOf(login: string): Promise<number | null> {
    try {
      return (await this.get<{ id: number }>(`/users/${encodeURIComponent(login)}`)).id;
    } catch {
      return null;
    }
  }

  /** Unique authors of commits touching the history file — the session's contributors. */
  async historyContributors(fullName: string): Promise<Contributor[]> {
    interface CommitEntry {
      author: { id: number; login: string; avatar_url: string } | null;
      commit: { author: { name: string; date: string } | null };
    }
    const commits = await this.get<CommitEntry[]>(
      `/repos/${fullName}/commits?path=${HISTORY_FILE}&per_page=50`,
    );
    const byId = new Map<number, Contributor>();
    for (const c of commits) {
      if (!c.author) continue; // commit author has no GitHub account mapping
      const cur = byId.get(c.author.id);
      const date = c.commit.author?.date ?? '';
      if (!cur) {
        byId.set(c.author.id, {
          id: c.author.id,
          login: c.author.login,
          avatarUrl: c.author.avatar_url,
          lastActive: date,
          commits: 1,
        });
      } else {
        cur.commits += 1;
        if (date > cur.lastActive) cur.lastActive = date;
      }
    }
    return [...byId.values()];
  }

  async fetchHistoryFile(fullName: string, branch = 'HEAD'): Promise<string> {
    const res = await fetch(
      `https://raw.githubusercontent.com/${fullName}/${encodeURIComponent(branch)}/${HISTORY_FILE}`,
    );
    if (!res.ok) throw new Error(`raw fetch ${res.status} for ${fullName}`);
    return res.text();
  }
}
