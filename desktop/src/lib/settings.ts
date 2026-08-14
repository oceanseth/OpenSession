/**
 * App settings, persisted to localStorage and shared across components via
 * useSyncExternalStore — the Daytona key lives here so the bench panel and
 * the settings dialog never drift.
 */
import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';

export interface Settings {
  theme: Theme;
  daytonaApiKey: string;
  rocketrideApiKey: string;
  rocketrideUri: string;
  oauthClientId: string;
}

const KEY = 'opensession.desktop.settings';

// Pre-settings builds stored these separately; migrate them once.
const LEGACY_DAYTONA_KEY = 'opensession.desktop.daytona-key';
const LEGACY_CLIENT_ID_KEY = 'opensession.desktop.oauth-client-id';

const DEFAULTS: Settings = {
  theme: 'dark',
  daytonaApiKey: '',
  rocketrideApiKey: '',
  rocketrideUri: 'https://cloud.rocketride.ai',
  oauthClientId: '',
};

function load(): Settings {
  let stored: Partial<Settings> = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
  } catch {
    /* corrupted settings fall back to defaults */
  }
  const migrated: Partial<Settings> = {};
  if (stored.daytonaApiKey === undefined) {
    const legacy = localStorage.getItem(LEGACY_DAYTONA_KEY);
    if (legacy) migrated.daytonaApiKey = legacy;
  }
  if (stored.oauthClientId === undefined) {
    const legacy = localStorage.getItem(LEGACY_CLIENT_ID_KEY);
    if (legacy) migrated.oauthClientId = legacy;
  }
  return { ...DEFAULTS, ...migrated, ...stored };
}

let current = load();
const listeners = new Set<() => void>();

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  localStorage.setItem(KEY, JSON.stringify(current));
  for (const l of listeners) l();
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
