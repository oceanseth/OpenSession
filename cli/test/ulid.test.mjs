import test from 'node:test';
import assert from 'node:assert/strict';
import { ulid, deterministicUlid, ULID_RE } from '../lib/ulid.mjs';

test('ulid shape and time-sortability', () => {
  const a = ulid(1000);
  const b = ulid(2000);
  assert.match(a, ULID_RE);
  assert.match(b, ULID_RE);
  assert.ok(a.slice(0, 10) < b.slice(0, 10));
});

test('deterministicUlid is stable for the same seed and distinct across seeds', () => {
  const ts = Date.parse('2026-10-03T19:02:38.399Z');
  const a1 = deterministicUlid(ts, 'turn|claude-code|sess-1|uuid-1');
  const a2 = deterministicUlid(ts, 'turn|claude-code|sess-1|uuid-1');
  const b = deterministicUlid(ts, 'turn|claude-code|sess-1|uuid-2');
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.match(a1, ULID_RE);
});
