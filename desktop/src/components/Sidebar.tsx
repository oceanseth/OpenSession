import { useEffect, useState } from 'react';
import { sessionLabel } from '@oslib/opensession';
import type { RepoEntry, Selection } from '../App';
import { sessionKey } from '../lib/seen';
import { engagedThreadIds, type DesktopThreadsClient, type Thread } from '../lib/threads';

export function Sidebar({
  viewer,
  entries,
  scanStatus,
  selection,
  unseenByRepo,
  unseenBySession,
  flashing,
  threadsClient,
  onOpenRepo,
  onSelect,
  onOpenThreads,
  onOpenThread,
  onOpenSettings,
  onSignOut,
}: {
  viewer: { login: string; avatar_url: string } | null;
  entries: Map<string, RepoEntry>;
  scanStatus?: string;
  selection: Selection | null;
  unseenByRepo: Map<string, number>;
  unseenBySession: Map<string, number>;
  flashing: Set<string>;
  threadsClient: DesktopThreadsClient | null;
  onOpenRepo: (fullName: string) => void;
  onSelect: (s: Selection) => void;
  onOpenThreads: () => void;
  onOpenThread: (id: string) => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
}) {
  const [reposOpen, setReposOpen] = useState(true);
  const [threadsOpen, setThreadsOpen] = useState(true);
  const [engaged, setEngaged] = useState<Thread[]>([]);

  // Engaged threads = ones we created / replied to / voted on (tracked locally).
  useEffect(() => {
    if (!threadsClient) return;
    const ids = engagedThreadIds();
    if (ids.size === 0) return;
    void threadsClient
      .list()
      .then((all) => setEngaged(all.filter((t) => ids.has(t.id))))
      .catch(() => {
        /* sidebar stays usable without the threads API */
      });
  }, [threadsClient]);

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
        <button className="sidebar-section" onClick={() => setReposOpen((v) => !v)}>
          <span className={`chev${reposOpen ? ' open' : ''}`}>▸</span> Session repos
        </button>
        {reposOpen &&
          sorted.map((entry) => {
            const fullName = entry.repo.full_name;
            const isOpen = entry.archive && selection?.repo === fullName;
            const repoUnseen = unseenByRepo.get(fullName) ?? 0;
            return (
              <div key={fullName} className="repo-block">
                <button
                  className={`repo-name${selection?.repo === fullName ? ' active' : ''}${
                    flashing.has(fullName) ? ' flash' : ''
                  }`}
                  onClick={() => onOpenRepo(fullName)}
                >
                  <span className="repo-label">{fullName}</span>
                  {entry.loading && <span className="muted"> …</span>}
                  {repoUnseen > 0 && <span className="unseen">{repoUnseen}</span>}
                  {!entry.archive && flashing.has(fullName) && <span className="unseen dot" />}
                </button>
                {entry.error && <div className="status error small">{entry.error}</div>}
                {isOpen &&
                  entry.archive!.sessions.map((s, i) => {
                    const n = unseenBySession.get(sessionKey(fullName, s.session.sid, i)) ?? 0;
                    return (
                      <button
                        key={s.session.sid ?? i}
                        className={`channel${selection?.session === i ? ' active' : ''}`}
                        onClick={() => onSelect({ repo: fullName, session: i })}
                      >
                        <span className="hash">#</span>
                        <span className="channel-name">{sessionLabel(s, i)}</span>
                        {n > 0 ? (
                          <span className="unseen">{n}</span>
                        ) : (
                          <span className="count">{s.messages.length}</span>
                        )}
                      </button>
                    );
                  })}
              </div>
            );
          })}

        <button
          className="sidebar-section"
          onClick={() => {
            setThreadsOpen((v) => !v);
            onOpenThreads();
          }}
        >
          <span className={`chev${threadsOpen ? ' open' : ''}`}>▸</span> Threads
        </button>
        {threadsOpen && (
          <div className="engaged-threads">
            {engaged.map((t) => (
              <button key={t.id} className="channel" onClick={() => onOpenThread(t.id)}>
                <span className="hash">💬</span>
                <span className="channel-name">{t.title}</span>
                <span className="count">{t.reply_count}</span>
              </button>
            ))}
            {engaged.length === 0 && (
              <div className="scan-status">Threads you start or reply to appear here.</div>
            )}
          </div>
        )}

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
