import { useEffect } from 'react';
import { OPENSESSION_REPO, OPENSESSION_REPO_URL } from '../lib/star';

/**
 * Shown once to a signed-in user who hasn't starred OpenSession: starring is
 * what pulls this project's own session log into their feed.
 */
export function StarInvite({ onDismiss }: { onDismiss: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onDismiss();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    <div className="popup-overlay" onClick={onDismiss}>
      <div
        className="popup card"
        role="dialog"
        aria-modal="true"
        aria-label={`Star ${OPENSESSION_REPO}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="popup-head">
          <span>★ Star OpenSession</span>
          <button className="ghost" aria-label="Dismiss" onClick={onDismiss}>✕</button>
        </header>

        <div className="popup-body">
          <p>
            You're connected — one more step. Star{' '}
            <a href={OPENSESSION_REPO_URL} target="_blank" rel="noreferrer">{OPENSESSION_REPO}</a>{' '}
            and this project's own build history joins your feed: OpenSession is written under the
            Open Session License, so every session that produced it is public. You'll be able to
            watch the turns land live, replay them, and discuss them right here.
          </p>
          <a className="star-cta" href={OPENSESSION_REPO_URL} target="_blank" rel="noreferrer">
            ★ Star on GitHub
          </a>
          <p className="status">
            <button className="ghost inline" onClick={onDismiss}>Maybe later</button>
          </p>
        </div>
      </div>
    </div>
  );
}
