/**
 * GitHub OAuth (web application flow) for the SPA.
 *
 * The client secret lives in the opensession-auth Lambda; the SPA only
 * redirects to GitHub and swaps the returned ?code= for a token via the
 * exchange endpoint. Client ID comes from VITE_OAUTH_CLIENT_ID at build
 * time — when unset (e.g. a fork without OAuth configured), the login
 * button is hidden and the PAT flow still works.
 */

export const OAUTH_CLIENT_ID: string | undefined = import.meta.env.VITE_OAUTH_CLIENT_ID;

export const TOKEN_ENDPOINT = import.meta.env.DEV
  ? 'https://r1q8b3li40.execute-api.us-east-1.amazonaws.com/token'
  : '/api/token';

const STATE_KEY = 'opensession.oauth.state';

export function beginLogin(): void {
  if (!OAUTH_CLIENT_ID) return;
  const state = crypto.randomUUID();
  sessionStorage.setItem(STATE_KEY, state);
  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: `${window.location.origin}/`,
    scope: 'read:user',
    state,
  });
  window.location.href = `https://github.com/login/oauth/authorize?${params}`;
}

/**
 * If the current URL is an OAuth callback (?code=…&state=…), exchange the
 * code for an access token and clean the URL. Returns null when the URL is
 * not a callback.
 */
export async function completeLogin(): Promise<string | null> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  if (!code) return null;

  const expected = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(STATE_KEY);
  window.history.replaceState({}, '', window.location.pathname + window.location.hash);
  if (!expected || state !== expected) {
    throw new Error('OAuth state mismatch — please try signing in again.');
  }

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || data.error || !data.access_token) {
    throw new Error(data.error_description ?? data.error ?? `token exchange failed (${res.status})`);
  }
  return data.access_token;
}
