import { OPENSESSION_REPO, OPENSESSION_REPO_URL } from '@oslib/star';

/**
 * Shown once to a signed-in user who hasn't starred OpenSession: starring is
 * what pulls this project's own session log into the sidebar alongside theirs.
 */
export function StarInvite({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onDismiss}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Star ${OPENSESSION_REPO}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>★ Star OpenSession</h2>
          <button className="icon-btn" aria-label="Dismiss" onClick={onDismiss}>
            ✕
          </button>
        </header>

        <section className="setting">
          <div className="setting-label">
            <span>
              Star <strong>{OPENSESSION_REPO}</strong> and this project's own build history joins
              your sidebar. OpenSession is written under the Open Session License, so every session
              that produced it is public — you'll be able to watch its turns land live, replay them,
              and discuss them here.
            </span>
          </div>
        </section>

        <footer className="modal-foot">
          <button className="ghost" onClick={onDismiss}>
            Maybe later
          </button>
          <button className="primary" onClick={() => void window.desktop.openExternal(OPENSESSION_REPO_URL)}>
            ★ Star on GitHub
          </button>
        </footer>
      </div>
    </div>
  );
}
