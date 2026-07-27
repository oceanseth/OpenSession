import { describe, expect, it } from 'vitest';
import { mergeDelta, toCached } from './history-cache';

const enc = (s: string) => new TextEncoder().encode(s);

describe('mergeDelta', () => {
  it('appends new bytes when the overlap matches', () => {
    const cached = toCached('line one\nline two\n', 'sha1');
    const start = cached.byteLength - 9; // overlap covers "line two\n"
    const chunk = enc('line two\nline three\n');
    expect(mergeDelta(cached, chunk, start)).toBe('line one\nline two\nline three\n');
  });

  it('handles start at 0 (full-file range)', () => {
    const cached = toCached('abc', 'sha1');
    expect(mergeDelta(cached, enc('abcdef'), 0)).toBe('abcdef');
  });

  it('rejects a rewritten file (overlap mismatch)', () => {
    const cached = toCached('original content\n', 'sha1');
    const chunk = enc('rewritten tail\n');
    expect(mergeDelta(cached, chunk, cached.byteLength - 5)).toBeNull();
  });

  it('rejects a chunk shorter than the overlap window', () => {
    const cached = toCached('0123456789', 'sha1');
    expect(mergeDelta(cached, enc('89'), 5)).toBeNull();
  });

  it('is byte-accurate with multibyte characters', () => {
    const cached = toCached('turn: “héllo” — ok\n', 'sha1');
    const tail = 'more — “日本語” ✓\n';
    const full = cached.text + tail;
    const fullBytes = enc(full);
    const start = cached.byteLength - 4;
    const chunk = fullBytes.subarray(start);
    expect(mergeDelta(cached, chunk, start)).toBe(full);
    expect(toCached(full, 'x').byteLength).toBe(fullBytes.length);
  });

  it('rejects start beyond the cached length', () => {
    const cached = toCached('short', 'sha1');
    expect(mergeDelta(cached, enc('anything'), 99)).toBeNull();
  });
});
