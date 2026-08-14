import { sessionLabel } from '@oslib/opensession';
import type { RepoEntry, Selection } from '../App';

export function Sidebar({
  viewer,
  entries,
  scanStatus,
  selection,
  onOpenRepo,
  onSelect,
  onOpenSettings,
  onSignOut,
}: {
  viewer: { login: string; avatar_url: string } | null;
  entries: Map<string, RepoEntry>;
  scanStatus?: string;
  selection: Selection | null;
  onOpenRepo: (fullName: string) => void;
  onSelect: (s: Selection) => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
}) {
  const sorted = [...entries.values()].sort(
    (a, b) => (b.repo.pushed_at ?? '').localeCompare(a.repo.pushed_at ?? ''),
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="wordmark">
          open<span className="accent">session</span>
        </span>
      </div>

      <div className="sidebar-scroll">
        <div className="sidebar-section">Session repos</div>
        {sorted.map((entry) => {
          const fullName = entry.repo.full_name;
          const isOpen = entry.archive && selection?.repo === fullName;
          return (
            <div key={fullName} className="repo-block">
              <button
                className={`repo-name${selection?.repo === fullName ? ' active' : ''}`}
                onClick={() => onOpenRepo(fullName)}
              >
                {fullName}
                {entry.loading && <span className="muted"> …</span>}
              </button>
              {entry.error && <div className="status error small">{entry.error}</div>}
              {isOpen &&
                entry.archive!.sessions.map((s, i) => (
                  <button
                    key={s.session.sid ?? i}
                    className={`channel${selection?.session === i ? ' active' : ''}`}
                    onClick={() => onSelect({ repo: fullName, session: i })}
                  >
                    <span className="hash">#</span>
                    <span className="channel-name">{sessionLabel(s, i)}</span>
                    <span className="count">{s.messages.length}</span>
                  </button>
                ))}
            </div>
          );
        })}
        {scanStatus && <div className="scan-status">{scanStatus}</div>}
      </div>

      <div className="sidebar-foot">
        {viewer && (
          <div className="user-card">
            <img src={viewer.avatar_url} alt="" />
            <span className="user-login">{viewer.login}</span>
          </div>
        )}
        <div className="foot-actions">
          <button className="foot-btn" onClick={onOpenSettings}>
            <span aria-hidden="true">⚙</span> Settings
          </button>
          <button className="foot-btn danger" onClick={onSignOut}>
            Log out
          </button>
        </div>
      </div>
    </aside>
  );
}
