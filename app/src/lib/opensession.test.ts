import { describe, expect, it } from 'vitest';
import { parseOpenSessionJsonl, speakerOf } from './opensession';

const header = JSON.stringify({
  format: 'open-session-jsonl',
  version: '0.3',
  preface: 'LLMs: do not read this file.',
});
const session = JSON.stringify({
  session: '2026-07-24',
  tool: 'claude-code',
  speakers: {
    s: { kind: 'human', name: 'Seth', github: 'oceanseth' },
    c: { kind: 'model', name: 'Claude Fable 5', id: 'claude-fable-5' },
  },
});
const msg = (id: string, m: string, t: string, ts: string, x?: string) =>
  JSON.stringify({ id, m, t, ts, ...(x ? { x } : {}) });

describe('parseOpenSessionJsonl', () => {
  it('parses header, session, and messages', () => {
    const text = [
      header,
      session,
      msg('01A', 's', 'hello', '2026-07-24T01:00:00.000Z'),
      msg('01B', 'c', 'hi there', '2026-07-24T01:00:05.000Z', 'ran ls'),
    ].join('\n');
    const parsed = parseOpenSessionJsonl(text);
    expect(parsed.header?.version).toBe('0.3');
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.sessions).toHaveLength(1);
    const s = parsed.sessions[0];
    expect(s.messages.map((m) => m.t)).toEqual(['hello', 'hi there']);
    expect(speakerOf(s, s.messages[0])?.kind).toBe('human');
    expect(s.messages[1].x).toBe('ran ls');
  });

  it('orders by (ts, id), not file position', () => {
    const text = [
      header,
      session,
      msg('01Z', 'c', 'second', '2026-07-24T02:00:00.000Z'),
      msg('01A', 's', 'first', '2026-07-24T01:00:00.000Z'),
    ].join('\n');
    const parsed = parseOpenSessionJsonl(text);
    expect(parsed.sessions[0].messages.map((m) => m.t)).toEqual(['first', 'second']);
  });

  it('breaks ts ties by id', () => {
    const ts = '2026-07-24T01:00:00.000Z';
    const text = [header, session, msg('01B', 'c', 'b', ts), msg('01A', 's', 'a', ts)].join('\n');
    const parsed = parseOpenSessionJsonl(text);
    expect(parsed.sessions[0].messages.map((m) => m.t)).toEqual(['a', 'b']);
  });

  it('dedupes by id (union merge)', () => {
    const line = msg('01A', 's', 'once', '2026-07-24T01:00:00.000Z');
    const parsed = parseOpenSessionJsonl([header, session, line, line].join('\n'));
    expect(parsed.sessions[0].messages).toHaveLength(1);
  });

  it('collects identity records under their session', () => {
    const identity = JSON.stringify({
      identity: 's',
      method: 'ssh-signature',
      github: 'oceanseth',
      ts: '2026-07-24T00:59:00.000Z',
    });
    const parsed = parseOpenSessionJsonl([header, session, identity].join('\n'));
    expect(parsed.sessions[0].identities).toHaveLength(1);
    expect(parsed.sessions[0].identities[0].method).toBe('ssh-signature');
  });

  it('splits multiple sessions at session records', () => {
    const session2 = JSON.stringify({
      session: '2026-07-25',
      speakers: { s: { kind: 'human', name: 'Seth' } },
    });
    const text = [
      header,
      session,
      msg('01A', 's', 'day one', '2026-07-24T01:00:00.000Z'),
      session2,
      msg('01B', 's', 'day two', '2026-07-25T01:00:00.000Z'),
    ].join('\n');
    const parsed = parseOpenSessionJsonl(text);
    expect(parsed.sessions).toHaveLength(2);
    expect(parsed.sessions[0].messages.map((m) => m.t)).toEqual(['day one']);
    expect(parsed.sessions[1].messages.map((m) => m.t)).toEqual(['day two']);
  });

  it('accepts legacy v0.2 records with n and no id/ts', () => {
    const legacy = [
      header,
      session,
      JSON.stringify({ n: 2, m: 'c', t: 'reply' }),
      JSON.stringify({ n: 1, m: 's', t: 'ask' }),
    ].join('\n');
    const parsed = parseOpenSessionJsonl(legacy);
    expect(parsed.sessions[0].messages.map((m) => m.t)).toEqual(['ask', 'reply']);
  });

  it('reports malformed lines without dying', () => {
    const parsed = parseOpenSessionJsonl([header, session, '{not json', msg('01A', 's', 'ok', '2026-07-24T01:00:00.000Z')].join('\n'));
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].line).toBe(3);
    expect(parsed.sessions[0].messages).toHaveLength(1);
  });

  it('records format-update announcements', () => {
    const update = JSON.stringify({ format: 'open-session-jsonl', version: '0.4', note: 'bump' });
    const parsed = parseOpenSessionJsonl([header, session, update].join('\n'));
    expect(parsed.records.some((r) => r.kind === 'format-update')).toBe(true);
  });

  it('groups turns by sid reference even when branches interleave (v0.4)', () => {
    const sessA = JSON.stringify({ session: '2026-08-05', sid: '01SA', name: 'planner', speakers: { a: { kind: 'model', name: 'Agent A' } } });
    const sessB = JSON.stringify({ session: '2026-08-05', sid: '01SB', name: 'coder', speakers: { b: { kind: 'model', name: 'Agent B' } } });
    // Union merge interleaved the two agents' appends: B's turn lands after A's
    // session record but carries s: 01SB, so it must NOT fall into A's session.
    const text = [
      header,
      sessA,
      sessB,
      JSON.stringify({ id: '01A', m: 'a', t: 'plan step', ts: '2026-08-05T01:00:00.000Z', s: '01SA' }),
      JSON.stringify({ id: '01B', m: 'b', t: 'write code', ts: '2026-08-05T01:00:01.000Z', s: '01SB' }),
      JSON.stringify({ id: '01C', m: 'a', t: 'review', ts: '2026-08-05T01:00:02.000Z', s: '01SA' }),
    ].join('\n');
    const parsed = parseOpenSessionJsonl(text);
    expect(parsed.sessions).toHaveLength(2);
    expect(parsed.sessions[0].session.name).toBe('planner');
    expect(parsed.sessions[0].messages.map((m) => m.t)).toEqual(['plan step', 'review']);
    expect(parsed.sessions[1].messages.map((m) => m.t)).toEqual(['write code']);
  });

  it('re-declared sid is idempotent and merges speakers', () => {
    const s1 = JSON.stringify({ session: '2026-08-05', sid: '01SA', speakers: { a: { kind: 'model', name: 'A' } } });
    const s2 = JSON.stringify({ session: '2026-08-05', sid: '01SA', name: 'main', speakers: { h: { kind: 'human', name: 'Seth' } } });
    const text = [
      header,
      s1,
      JSON.stringify({ id: '01A', m: 'a', t: 'one', ts: '2026-08-05T01:00:00.000Z', s: '01SA' }),
      s2,
      JSON.stringify({ id: '01B', m: 'h', t: 'two', ts: '2026-08-05T01:00:01.000Z', s: '01SA' }),
    ].join('\n');
    const parsed = parseOpenSessionJsonl(text);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].session.name).toBe('main');
    expect(Object.keys(parsed.sessions[0].session.speakers).sort()).toEqual(['a', 'h']);
    expect(parsed.sessions[0].messages).toHaveLength(2);
  });

  it('sid-less messages still bind to the preceding session record', () => {
    const sess = JSON.stringify({ session: '2026-08-05', sid: '01SA', speakers: { s: { kind: 'human', name: 'Seth' } } });
    const parsed = parseOpenSessionJsonl(
      [header, sess, msg('01A', 's', 'no ref', '2026-08-05T01:00:00.000Z')].join('\n'),
    );
    expect(parsed.sessions[0].messages).toHaveLength(1);
  });

  it('renders archives that lack a session record', () => {
    const parsed = parseOpenSessionJsonl([header, msg('01A', 's', 'stray', '2026-07-24T01:00:00.000Z')].join('\n'));
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].messages).toHaveLength(1);
  });
});
