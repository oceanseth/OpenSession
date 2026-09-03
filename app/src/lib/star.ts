/**
 * The "star OpenSession" invite, shared by the web feed and the desktop app.
 *
 * OpenSession's own repo is written under the Open Session License, so its
 * history file is a live session log like any other: starring it is what puts
 * this project's own build sessions in the viewer's feed. A signed-in user who
 * hasn't starred it is invited once — dismissal is remembered per device.
 */

export const OPENSESSION_REPO = 'oceanseth/OpenSession';
export const OPENSESSION_REPO_URL = `https://github.com/${OPENSESSION_REPO}`;

const DISMISSED_KEY = 'opensession.starprompt.dismissed';

/** Has this device already answered (or waved off) the invite? */
export function starInviteDismissed(storage: Pick<Storage, 'getItem'> = localStorage): boolean {
  try {
    return storage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false; // storage blocked (private mode) — asking again beats crashing
  }
}

/** Remember "maybe later" so the invite doesn't return on every visit. */
export function dismissStarInvite(storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(DISMISSED_KEY, '1');
  } catch {
    /* storage blocked — the invite stays dismissed for this session only */
  }
}
