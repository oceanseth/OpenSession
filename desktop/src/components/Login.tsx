import { useEffect, useRef, useState } from 'react';
import { getSettings, updateSettings } from '../lib/settings';
import type { DeviceCodeResponse } from '../types';

// Same OAuth app as the production web feed (client ids are public); the
// Settings value or VITE_OAUTH_CLIENT_ID overrides it.
const DEFAULT_CLIENT_ID = 'Ov23liYLjM6PFF3MKJa0';
const ENV_CLIENT_ID: string | undefined = import.meta.env.VITE_OAUTH_CLIENT_ID;

function resolveClientId(): string {
  return getSettings().oauthClientId || ENV_CLIENT_ID || DEFAULT_CLIENT_ID;
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/**
 * Minimal sign-in: one GitHub button driving the device flow (client id is
 * baked in / overridable in Settings), with a PAT paste below.
 */
export function Login({ onToken }: { onToken: (t: string) => void }) {
  const [device, setDevice] = useState<DeviceCodeResponse | null>(null);
  const [pat, setPat] = useState('');
  const [status, setStatus] = useState<string>();
  const clientIdRef = useRef(resolveClientId());
  const polling = useRef(false);

  const startDeviceFlow = async () => {
    setStatus(undefined);
    clientIdRef.current = resolveClientId();
    updateSettings({ oauthClientId: clientIdRef.current });
    try {
      setDevice(await window.desktop.deviceStart(clientIdRef.current));
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
      const res = await window.desktop.devicePoll(clientIdRef.current, device.device_code);
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
  }, [device, onToken]);

  return (
    <div className="login">
      <div className="login-card">
        <h1>
          open<span className="accent">session</span> <span className="desktop-tag">desktop</span>
        </h1>

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
          <button className="github-btn" onClick={() => void startDeviceFlow()}>
            <GitHubMark /> Sign in with GitHub
          </button>
        )}

        <div className="login-divider">or</div>

        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (pat.trim()) onToken(pat.trim());
          }}
        >
          <input
            type="password"
            placeholder="Personal access token"
            value={pat}
            onChange={(e) => setPat(e.target.value)}
          />
          <button type="submit" disabled={!pat.trim()}>
            Use token
          </button>
        </form>

        {status && <p className="status error">{status}</p>}
      </div>
    </div>
  );
}
