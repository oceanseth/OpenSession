import { useState } from 'react';
import { updateSettings, useSettings, type Theme } from '../lib/settings';

/** App preferences: appearance, Daytona credentials, GitHub OAuth client. */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useSettings();
  const [showKey, setShowKey] = useState(false);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>Settings</h2>
          <button className="icon-btn" aria-label="Close settings" onClick={onClose}>
            ✕
          </button>
        </header>

        <section className="setting">
          <div className="setting-label">
            <strong>Appearance</strong>
            <span>Theme applies immediately and persists on this machine.</span>
          </div>
          <div className="segmented" role="radiogroup" aria-label="Theme">
            {(['dark', 'light'] as Theme[]).map((t) => (
              <button
                key={t}
                role="radio"
                aria-checked={settings.theme === t}
                className={settings.theme === t ? 'active' : ''}
                onClick={() => updateSettings({ theme: t })}
              >
                {t === 'dark' ? 'Dark' : 'Light'}
              </button>
            ))}
          </div>
        </section>

        <section className="setting">
          <div className="setting-label">
            <strong>Daytona API key</strong>
            <span>
              Used to create disposable sandboxes for clean-room benchmark runs. Stored locally,
              never committed to reports.
            </span>
          </div>
          <div className="row">
            <input
              type={showKey ? 'text' : 'password'}
              placeholder="dtn_…"
              value={settings.daytonaApiKey}
              onChange={(e) => updateSettings({ daytonaApiKey: e.target.value.trim() })}
            />
            <button className="ghost" onClick={() => setShowKey((v) => !v)}>
              {showKey ? 'Hide' : 'Show'}
            </button>
          </div>
        </section>

        <section className="setting">
          <div className="setting-label">
            <strong>RocketRide API key</strong>
            <span>
              Runs the turn-heuristics pipeline (grounded LLM judge) on RocketRide Cloud. Stored
              locally. Sign in at cloud.rocketride.ai to get a key.
            </span>
          </div>
          <input
            type="password"
            placeholder="RocketRide API key"
            value={settings.rocketrideApiKey}
            onChange={(e) => updateSettings({ rocketrideApiKey: e.target.value.trim() })}
          />
        </section>

        <section className="setting">
          <div className="setting-label">
            <strong>GitHub OAuth client id</strong>
            <span>
              Optional — enables device-flow sign-in. Leave blank to use a personal access token.
            </span>
          </div>
          <input
            placeholder="Iv1.…"
            value={settings.oauthClientId}
            onChange={(e) => updateSettings({ oauthClientId: e.target.value.trim() })}
          />
        </section>

        <footer className="modal-foot">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
