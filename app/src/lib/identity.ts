/**
 * GitHub ⇄ X identity linking against the OpenSession registry.
 *
 * Trust ladder for how a handle was linked: 'claimed' (self-asserted in the
 * web app) < 'extension' (the xChatHub extension witnessed the handle logged
 * in on x.com in this browser). The server refuses to downgrade.
 */

const API = import.meta.env.DEV ? 'https://r1q8b3li40.execute-api.us-east-1.amazonaws.com/api' : '/api';

export type LinkMethod = 'claimed' | 'extension';

export interface Identity {
  github_id: number;
  github_login: string;
  x_handle: string;
  method: LinkMethod;
  linked_at: number;
}

/** Normalize user input to a bare X username, or null if invalid. */
export function normalizeXHandle(input: string): string | null {
  const m = input.trim().match(/^@?([A-Za-z0-9_]{1,15})$/);
  return m ? m[1] : null;
}

export class IdentityClient {
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
      throw new Error(d.error_description ?? d.error ?? `identity API ${res.status}`);
    }
    return data as T;
  }

  async mine(): Promise<Identity | null> {
    return (await this.call<{ identity: Identity | null }>('GET', '/identity')).identity;
  }

  async linkX(handle: string, method: LinkMethod = 'claimed'): Promise<Identity> {
    return (await this.call<{ identity: Identity }>('PUT', '/identity/x', { handle, method })).identity;
  }

  async unlinkX(): Promise<void> {
    await this.call('DELETE', '/identity/x');
  }

  /** Map GitHub user ids → linked X identities (unlinked users are absent). */
  async resolve(githubIds: number[]): Promise<Record<number, Identity>> {
    if (githubIds.length === 0) return {};
    return (
      await this.call<{ identities: Record<number, Identity> }>('POST', '/identity/resolve', {
        github_ids: githubIds.slice(0, 500),
      })
    ).identities;
  }
}

/**
 * Listen for an X-handle attestation posted into the page by the xChatHub
 * extension's (forthcoming) OpenSession content script:
 *   window.postMessage({ type: 'opensession:x-attest', handle: '<handle>' }, origin)
 * Returns an unsubscribe function.
 */
export function onExtensionAttestation(cb: (handle: string) => void): () => void {
  const listener = (e: MessageEvent) => {
    if (e.origin !== window.location.origin) return;
    const data = e.data as { type?: string; handle?: string };
    if (data?.type === 'opensession:x-attest' && typeof data.handle === 'string') {
      const handle = normalizeXHandle(data.handle);
      if (handle) cb(handle);
    }
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
