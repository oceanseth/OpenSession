import { useState } from 'react';
import {
  speakerOf,
  type MessageRecord,
  type ParsedArchive,
  type ParsedSession,
} from '../lib/opensession';

interface SessionViewProps {
  title: string;
  archive: ParsedArchive;
  sourceUrl?: string;
  onBack: () => void;
}

export function SessionView({ title, archive, sourceUrl, onBack }: SessionViewProps) {
  return (
    <div className="session-view">
      <div className="session-toolbar">
        <button className="ghost" onClick={onBack}>← feed</button>
        <h2>{title}</h2>
        {sourceUrl && (
          <a href={sourceUrl} target="_blank" rel="noreferrer" className="source-link">
            source ↗
          </a>
        )}
      </div>

      {archive.header?.preface && <p className="preface">“{archive.header.preface}”</p>}

      {archive.errors.length > 0 && (
        <p className="status error">
          {archive.errors.length} line{archive.errors.length > 1 ? 's' : ''} failed to parse (first at line{' '}
          {archive.errors[0].line}).
        </p>
      )}

      {archive.sessions.length === 0 && <p className="status">No session records in this archive.</p>}

      {archive.sessions.map((s, i) => (
        <Session key={i} session={s} />
      ))}
    </div>
  );
}

function Session({ session }: { session: ParsedSession }) {
  const { speakers } = session.session;
  const attested = new Set(session.identities.map((r) => r.identity));
  return (
    <section className="session card">
      <header className="session-head">
        <span className="session-date">{session.session.session || 'undated session'}</span>
        {session.session.tool && <span className="session-tool">{session.session.tool}</span>}
        <span className="speakers">
          {Object.entries(speakers).map(([abbrev, sp]) => (
            <span key={abbrev} className={`speaker-chip ${sp.kind}`}>
              {sp.name ?? abbrev}
              {sp.kind === 'model' && sp.id ? ` (${sp.id})` : ''}
              {attested.has(abbrev) && <span title="identity attested"> ✓</span>}
            </span>
          ))}
        </span>
      </header>
      {session.identities.length > 0 && (
        <p className="identities">
          {session.identities.map((r, i) => (
            <span key={i} className="identity-chip" title={JSON.stringify(r, null, 2)}>
              {String(r.github ?? r.identity)} attested via {r.method}
            </span>
          ))}
        </p>
      )}
      <div className="turns">
        {session.messages.map((m) => (
          <Turn key={m.id} session={session} msg={m} />
        ))}
      </div>
    </section>
  );
}

function Turn({ session, msg }: { session: ParsedSession; msg: MessageRecord }) {
  const [expanded, setExpanded] = useState(false);
  const speaker = speakerOf(session, msg);
  const kind = speaker?.kind ?? 'human';
  const long = msg.t.length > 1200;
  const text = long && !expanded ? msg.t.slice(0, 1200) + '…' : msg.t;
  return (
    <article className={`turn ${kind}`}>
      <div className="turn-meta">
        <span className="turn-speaker">{speaker?.name ?? msg.m}</span>
        {msg.ts && <time dateTime={msg.ts}>{formatTs(msg.ts)}</time>}
      </div>
      <div className="turn-body">{text}</div>
      {long && (
        <button className="ghost expand" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'show less' : `show all ${msg.t.length.toLocaleString()} chars`}
        </button>
      )}
      {msg.x && <div className="turn-tools">⚙ {msg.x}</div>}
    </article>
  );
}

function formatTs(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
