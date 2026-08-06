import { useEffect, useState } from 'react';
import type { GitHubClient } from '../lib/github';
import { IdentityClient, type Identity } from '../lib/identity';
import type { XChatConnector, XChatStatus } from '../lib/xchat';
import { ConversationPane } from './Chat';

interface DmPopupProps {
  login: string; // GitHub login clicked in a session
  client: GitHubClient;
  token: string;
  connector: XChatConnector;
  onClose: () => void;
}

/**
 * Quick-DM popup for a session speaker: resolves the GitHub login → linked X
 * identity, and when the xChatHub connector reaches an x.com tab, embeds the
 * live DM thread (history + composer) right here.
 */
export function DmPopup({ login, client, token, connector, onClose }: DmPopupProps) {
  const [identity, setIdentity] = useState<Identity | null>();
  const [xstatus, setXstatus] = useState<XChatStatus>(connector.status);

  useEffect(() => connector.onStatus(setXstatus), [connector]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const id = await client.userIdOf(login);
      if (cancelled) return;
      if (!id) {
        setIdentity(null);
        return;
      }
      const identities = await new IdentityClient(token).resolve([id]);
      if (!cancelled) setIdentity(identities[id] ?? null);
    })().catch(() => !cancelled && setIdentity(null));
    return () => {
      cancelled = true;
    };
  }, [client, token, login]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="popup-overlay" onClick={onClose}>
      <div className="popup card" onClick={(e) => e.stopPropagation()}>
        <header className="popup-head">
          <span>
            <a href={`https://github.com/${login}`} target="_blank" rel="noreferrer">{login}</a>
            {identity && (
              <>
                {' '}·{' '}
                <a href={`https://x.com/${identity.x_handle}`} target="_blank" rel="noreferrer">
                  @{identity.x_handle}
                </a>
              </>
            )}
          </span>
          <button className="ghost" onClick={onClose}>✕</button>
        </header>

        {identity === undefined && <p className="status popup-body">Looking up linked X identity…</p>}

        {identity === null && (
          <p className="status popup-body">
            <strong>{login}</strong> hasn't linked an X account on OpenSession — reach them via{' '}
            <a href={`https://github.com/${login}`} target="_blank" rel="noreferrer">GitHub</a>.
          </p>
        )}

        {identity && xstatus.connected && (
          <div className="popup-thread">
            <ConversationPane connector={connector} handle={identity.x_handle} login={login} />
          </div>
        )}

        {identity && !xstatus.connected && (
          <div className="popup-body">
            <a className="dm-button" href={`https://x.com/${identity.x_handle}`} target="_blank" rel="noreferrer">
              Message @{identity.x_handle} on X
            </a>
            {xstatus.available && (
              <p>
                <button onClick={() => connector.openBridge()}>Open the X bridge</button>
              </p>
            )}
            <p className="fine">
              {xstatus.available ? (
                'Extension detected — the bridge is a small x.com window (keep it visible on screen); once it connects, this popup becomes a live DM thread with history.'
              ) : (
                <>
                  For in-page DMs, install the{' '}
                  <a
                    href="https://github.com/oceanseth/xChatHub#install-the-opensession-connected-version-this-fork"
                    target="_blank"
                    rel="noreferrer"
                  >
                    OpenSession fork of xChatHub
                  </a>{' '}
                  (loaded unpacked — the Chrome Web Store build doesn't include the OpenSession connector, so it
                  isn't detected here even when installed).
                </>
              )}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
