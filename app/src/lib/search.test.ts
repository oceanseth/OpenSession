import { describe, expect, it } from 'vitest';
import { parseOpenSessionJsonl } from './opensession';
import { excerptSegments, queryTerms, searchArchives } from './search';

const header = JSON.stringify({ format: 'open-session-jsonl', version: '0.4', preface: 'no read' });

function archiveWith(turns: { m: string; t: string; ts: string; id: string }[], sid = '01SIDAAAAAAAAAAAAAAAAAAAAA') {
  const session = JSON.stringify({
    session: '2026-10-01',
    tool: 'claude-code',
    sid,
    speakers: {
      h: { kind: 'human', name: 'Seth' },
      m: { kind: 'model', name: 'Claude', id: 'claude-opus-5' },
    },
  });
  return parseOpenSessionJsonl(
    [header, session, ...turns.map((t) => JSON.stringify({ ...t, s: sid }))].join('\n'),
  );
}

describe('session search', () => {
  const archive = archiveWith([
    { id: '01A', m: 'h', t: 'please fix the OAuth login bug', ts: '2026-10-01T10:00:00.000Z' },
    { id: '01B', m: 'm', t: 'Fixed the OAuth callback; the login flow now stores the token.', ts: '2026-10-01T10:01:00.000Z' },
    { id: '01C', m: 'h', t: 'unrelated turn about styling', ts: '2026-10-01T10:02:00.000Z' },
  ]);

  it('finds turns containing every query term, case-insensitively', () => {
    const hits = searchArchives([{ repo: 'o/r', archive }], 'oauth LOGIN');
    expect(hits.map((h) => h.turnId).sort()).toEqual(['01A', '01B']);
    expect(hits[0].repo).toBe('o/r');
    expect(hits[0].sessionIndex).toBe(0);
    expect(hits[0].excerpt).toContain('OAuth');
    expect(hits.every((h) => h.speakerName)).toBe(true);
  });

  it('AND semantics: a term missing from the turn excludes it', () => {
    const hits = searchArchives([{ repo: 'o/r', archive }], 'oauth styling');
    expect(hits).toHaveLength(0);
  });

  it('empty query returns nothing', () => {
    expect(searchArchives([{ repo: 'o/r', archive }], '   ')).toHaveLength(0);
    expect(queryTerms('  ')).toEqual([]);
  });

  it('ranks across repos and respects the limit', () => {
    const other = archiveWith(
      [{ id: '01Z', m: 'h', t: 'oauth oauth oauth everywhere', ts: '2026-10-02T10:00:00.000Z' }],
      '01SIDBBBBBBBBBBBBBBBBBBBBB',
    );
    const hits = searchArchives(
      [
        { repo: 'o/r', archive },
        { repo: 'o/other', archive: other },
      ],
      'oauth',
      2,
    );
    expect(hits).toHaveLength(2);
    expect(hits[0].repo).toBe('o/other'); // highest term frequency wins
  });

  it('builds long-turn excerpts around the match', () => {
    const long = archiveWith([
      { id: '01L', m: 'm', t: `${'x'.repeat(500)} the needle sits here ${'y'.repeat(500)}`, ts: '2026-10-01T11:00:00.000Z' },
    ]);
    const [hit] = searchArchives([{ repo: 'o/r', archive: long }], 'needle');
    expect(hit.excerpt).toContain('needle');
    expect(hit.excerpt.length).toBeLessThan(260);
    expect(hit.excerpt.startsWith('…')).toBe(true);
    expect(hit.excerpt.endsWith('…')).toBe(true);
  });

  it('splits excerpts into highlightable segments', () => {
    const segs = excerptSegments('Fix the OAuth login', queryTerms('oauth login'));
    expect(segs.filter((s) => s.match).map((s) => s.text)).toEqual(['OAuth', 'login']);
    expect(segs.map((s) => s.text).join('')).toBe('Fix the OAuth login');
  });
});
