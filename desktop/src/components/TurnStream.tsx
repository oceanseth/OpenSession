import { useEffect, useRef } from 'react';
import { speakerOf, type MessageRecord, type ParsedSession } from '@oslib/opensession';
import type { Thread } from '../lib/threads';

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

function excerpt(t: string): string {
  const oneLine = t.replace(/\s+/g, ' ').trim();
  return oneLine.length > 140 ? `${oneLine.slice(0, 140)}…` : oneLine;
}

/** Slack-style message stream: turns, their thread chips, and a discuss action. */
export function TurnStream({
  session,
  threadsByTurn,
  onOpenThread,
  onDiscuss,
}: {
  session: ParsedSession;
  threadsByTurn: Map<string, Thread[]>;
  onOpenThread: (id: string) => void;
  onDiscuss: (turn: { id: string; ts?: string; speaker?: string; excerpt: string }) => void;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView();
  }, [session]);

  const discuss = (msg: MessageRecord) =>
    onDiscuss({ id: msg.id, ts: msg.ts, speaker: msg.m, excerpt: excerpt(msg.t) });

  return (
    <div className="turns">
      {session.messages.map((msg) => {
        const speaker = speakerOf(session, msg);
        const name = speaker?.name ?? msg.m;
        const kind = speaker?.kind ?? 'human';
        const turnThreads = threadsByTurn.get(msg.id) ?? [];
        return (
          <div key={msg.id} className={`turn ${kind}`}>
            <div className={`avatar ${kind}`}>{initials(name)}</div>
            <div className="turn-body">
              <div className="turn-meta">
                <span className="speaker">{name}</span>
                {kind === 'model' && <span className="badge">model</span>}
                <span className="ts">{fmtTs(msg.ts)}</span>
                <button className="discuss-btn" title="Start a discussion on this turn" onClick={() => discuss(msg)}>
                  💬
                </button>
              </div>
              <div className="turn-text">{msg.t}</div>
              {msg.x && <div className="turn-activity">⚙ {msg.x}</div>}
              {turnThreads.length > 0 && (
                <div className="turn-threads">
                  {turnThreads.map((t) => (
                    <button key={t.id} className="thread-chip" onClick={() => onOpenThread(t.id)}>
                      💬 {t.title}
                      <span className="chip-count">{t.reply_count}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
      <div ref={bottom} />
    </div>
  );
}
