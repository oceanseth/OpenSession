import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubClient } from './github';
import { dismissStarInvite, OPENSESSION_REPO, starInviteDismissed } from './star';

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

/** A page of starred repos as /user/starred returns them. */
function starPage(names: string[]) {
  return names.map((full_name, i) => ({ id: i, full_name }));
}

function stubFetch(handler: (url: string) => { status: number; body?: unknown }) {
  const fetchMock = vi.fn(async (url: string) => {
    const { status, body } = handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('star invite dismissal', () => {
  it('is not dismissed by default, and sticks once dismissed', () => {
    const storage = fakeStorage();
    expect(starInviteDismissed(storage)).toBe(false);
    dismissStarInvite(storage);
    expect(starInviteDismissed(storage)).toBe(true);
  });

  it('treats unavailable storage as "not dismissed" rather than throwing', () => {
    const blocked = {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('storage disabled');
      },
    };
    expect(starInviteDismissed(blocked)).toBe(false);
    expect(() => dismissStarInvite(blocked)).not.toThrow();
  });
});

describe('GitHubClient.isStarred', () => {
  it('reads 204 as starred and 404 as not starred', async () => {
    stubFetch(() => ({ status: 204 }));
    expect(await new GitHubClient('t').isStarred(OPENSESSION_REPO)).toBe(true);

    stubFetch(() => ({ status: 404 }));
    expect(await new GitHubClient('t').isStarred(OPENSESSION_REPO)).toBe(false);
  });

  it('returns null when signed out — nobody is asked to star anonymously', async () => {
    const fetchMock = stubFetch(() => ({ status: 204 }));
    expect(await new GitHubClient().isStarred(OPENSESSION_REPO)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when the request fails outright', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await new GitHubClient('t').isStarred(OPENSESSION_REPO)).toBeNull();
  });

  it('falls back to the starred listing when the direct check is refused', async () => {
    stubFetch((url) =>
      url.includes('/user/starred?')
        ? { status: 200, body: starPage(['a/b', OPENSESSION_REPO]) }
        : { status: 403 },
    );
    expect(await new GitHubClient('t').isStarred(OPENSESSION_REPO)).toBe(true);
  });

  it('reports not-starred when the fallback listing is complete and lacks it', async () => {
    stubFetch((url) =>
      url.includes('/user/starred?') ? { status: 200, body: starPage(['a/b']) } : { status: 403 },
    );
    expect(await new GitHubClient('t').isStarred(OPENSESSION_REPO)).toBe(false);
  });

  it('stays null when the fallback window is full — the star could be past it', async () => {
    const full = starPage(Array.from({ length: 100 }, (_, i) => `o/r${i}`));
    stubFetch((url) =>
      url.includes('/user/starred?') ? { status: 200, body: full } : { status: 403 },
    );
    expect(await new GitHubClient('t').isStarred(OPENSESSION_REPO)).toBeNull();
  });
});
