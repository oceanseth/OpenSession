import { useEffect, useRef, useState } from 'react';
import { getSettings, updateSettings } from '../lib/settings';
import type { DeviceCodeResponse } from '../types';

const ENV_CLIENT_ID: string | undefined = import.meta.env.VITE_OAUTH_CLIENT_ID;

/**
 * GitHub sign-in: device flow when a client id is configured (the desktop
 * analog of the web app's redirect flow), PAT paste as the always-works
 * fallback — the same two doors the web feed offers.
 */
export function Login({ onToken }: { onToken: (t: string) => void }) {
  const [clientId, setClientId] = useState(() => getSettings().oauthClientId || ENV_CLIENT_ID || '');
  const [device, setDevice] = useState<DeviceCodeResponse | null>(null);
  const [pat, setPat] = useState('');
  const [status, setStatus] = useState<string>();
  const polling = useRef(false);

  const startDeviceFlow = async () => {
    const id = clientId.trim();
    if (!id) return;
    updateSettings({ oauthClientId: id });
    setStatus(undefined);
    try {
      setDevice(await window.desktop.deviceStart(id));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  // Poll for the token once the user has a code to enter.
  useEffect(() => {
    if (!device || polling.current) return;
    polling.current = true;
    let stopped = false;
    let interval = Math.max(5, device.interval) * 1000;
    const tick = async () => {
      if (stopped) return;
      const res = await window.desktop.devicePoll(clientId.trim(), device.device_code);
      if (stopped) return;
      if (res.access_token) {
        onToken(res.access_token);
        return;
      }
      if (res.error === 'slow_down') interval += 5000;
      else if (res.error && res.error !== 'authorization_pending') {
        setStatus(res.error_description ?? res.error);
        setDevice(null);
        polling.current = false;
        return;
      }
      setTimeout(() => void tick(), interval);
    };
    setTimeout(() => void tick(), interval);
    return () => {
      stopped = true;
      polling.current = false;
    };
  }, [device, clientId, onToken]);

  return (
    <div className="login">
      <div className="login-card">
        <h1>
          open<span className="accent">session</span> <span className="desktop-tag">desktop</span>
        </h1>
        <p className="login-tagline">
          Your starred repos' <code>llm-turn-history.jsonl</code> logs as channels — replay the
          turns, then benchmark them in a clean Daytona sandbox.
        </p>

        <section>
          <h3>Sign in with GitHub</h3>
          {device ? (
            <p className="device-code">
              Enter <strong>{device.user_code}</strong> at{' '}
              <a
                href={device.verification_uri}
                onClick={(e) => {
                  e.preventDefault();
                  void window.desktop.openExternal(device.verification_uri);
                }}
              >
                {device.verification_uri}
              </a>
              <br />
              <span className="muted">Waiting for authorization…</span>
            </p>
          ) : (
            <div className="row">
              <input
                placeholder="OAuth app client id"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
              <button onClick={() => void startDeviceFlow()} disabled={!clientId.trim()}>
                Sign in
              </button>
            </div>
          )}
          <p className="muted">
            Uses the device flow — enable it on the OAuth app. No client secret leaves GitHub.
          </p>
        </section>

        <section>
          <h3>…or paste a personal access token</h3>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (pat.trim()) onToken(pat.trim());
            }}
          >
            <input
              type="password"
              placeholder="ghp_… (read-only scopes are enough)"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
            />
            <button type="submit" disabled={!pat.trim()}>
              Use token
            </button>
          </form>
        </section>

        {status && <p className="status error">{status}</p>}
      </div>
    </div>
  );
}
