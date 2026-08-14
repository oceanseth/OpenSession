import { useEffect, useRef } from 'react';
import { speakerOf, type ParsedSession } from '@oslib/opensession';

function initials(name: string): string {
  return name
    .split(/[\s/-]+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function fmtTs(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

/** Slack-style message stream for one session's turns. */
export function TurnStream({ session }: { session: ParsedSession }) {
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView();
  }, [session]);

  return (
    <div className="turns">
      {session.messages.map((msg) => {
        const speaker = speakerOf(session, msg);
        const name = speaker?.name ?? msg.m;
        const kind = speaker?.kind ?? 'human';
        return (
          <div key={msg.id} className={`turn ${kind}`}>
            <div className={`avatar ${kind}`}>{initials(name)}</div>
            <div className="turn-body">
              <div className="turn-meta">
                <span className="speaker">{name}</span>
                {kind === 'model' && <span className="badge">model</span>}
                <span className="ts">{fmtTs(msg.ts)}</span>
              </div>
              <div className="turn-text">{msg.t}</div>
              {msg.x && <div className="turn-activity">⚙ {msg.x}</div>}
            </div>
          </div>
        );
      })}
      <div ref={bottom} />
    </div>
  );
}
