import { describe, expect, it } from 'vitest';
import { parseOpenSessionJsonl } from './opensession';
import { archiveUsage, fmtTokens, priceFor, sessionUsage, turnCost, usageSummary } from './usage';

const header = JSON.stringify({ format: 'open-session-jsonl', version: '0.5', preface: 'no read' });
const session = JSON.stringify({
  session: '2026-10-03',
  tool: 'claude-code',
  sid: '01SID',
  speakers: {
    h: { kind: 'human', name: 'Seth' },
    m: { kind: 'model', name: 'Claude', id: 'claude-opus-5' },
  },
});

describe('usage aggregation', () => {
  it('sums u records per session and estimates cost by model price', () => {
    const text = [
      header,
      session,
      JSON.stringify({ id: '01A', m: 'h', t: 'go', ts: '2026-10-03T10:00:00.000Z', s: '01SID' }),
      JSON.stringify({
        id: '01B', m: 'm', t: 'done', ts: '2026-10-03T10:01:00.000Z', s: '01SID',
        u: { in: 1000, out: 2000, cr: 1_000_000, cw: 0, ms: 5000, model: 'claude-opus-5' },
      }),
      JSON.stringify({
        id: '01C', m: 'm', t: 'more', ts: '2026-10-03T10:02:00.000Z', s: '01SID',
        u: { in: 500, out: 100, model: 'some-unknown-model' },
      }),
    ].join('\n');
    const archive = parseOpenSessionJsonl(text);
    const totals = sessionUsage(archive.sessions[0]);
    expect(totals.metered).toBe(2);
    expect(totals.in).toBe(1500);
    expect(totals.out).toBe(2100);
    expect(totals.cr).toBe(1_000_000);
    expect(totals.ms).toBe(5000);
    expect(totals.unpriced).toBe(1);
    // opus-5: 1000*5/1e6 + 2000*25/1e6 + 1e6*0.5/1e6 = 0.005 + 0.05 + 0.5
    expect(totals.cost).toBeCloseTo(0.555, 5);
    expect(archiveUsage(archive)).toEqual(totals);
    expect(usageSummary(totals)).toContain('tok');
    expect(usageSummary(totals)).toContain('≥$'); // unpriced turns flag the estimate as a floor
  });

  it('returns null summary when nothing is metered', () => {
    const archive = parseOpenSessionJsonl(
      [header, session, JSON.stringify({ id: '01A', m: 'h', t: 'hi', ts: '2026-10-03T10:00:00.000Z' })].join('\n'),
    );
    expect(usageSummary(sessionUsage(archive.sessions[0]))).toBeNull();
  });

  it('longest-prefix price match distinguishes opus 5.5 from opus 5', () => {
    expect(priceFor('claude-opus-5-5')?.in).toBe(4);
    expect(priceFor('claude-opus-5')?.in).toBe(5);
    expect(priceFor('claude-fable-5-1')?.out).toBe(50);
    expect(priceFor('gpt-6-astra')).toBeUndefined();
    expect(turnCost({ in: 1, model: 'gpt-6-astra' })).toBeUndefined();
  });

  it('formats token counts', () => {
    expect(fmtTokens(950)).toBe('950');
    expect(fmtTokens(48_200)).toBe('48.2k');
    expect(fmtTokens(2_700_000)).toBe('2.7M');
  });
});
