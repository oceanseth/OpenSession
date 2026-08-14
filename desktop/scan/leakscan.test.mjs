import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSecrets, sanitize, scanForLeaks, stripEncryptedBlocks, summarize } from './leakscan.mjs';

const SIGNATURE = 'A'.repeat(60);

test('detects an Anthropic-style signature envelope', () => {
  const text = `{"m":"model","t":"answer","signature":"${SIGNATURE}"}`;
  const findings = scanForLeaks(text);
  const enc = findings.filter((f) => f.category === 'encrypted-block');
  assert.equal(enc.length, 1);
  assert.equal(enc[0].kind, 'signature');
  assert.ok(!enc[0].preview.includes(SIGNATURE), 'preview must not contain the full payload');
});

test('detects a redacted_thinking block', () => {
  const text = '{"type":"redacted_thinking","data":"c2VjcmV0Zm9v"}';
  const findings = scanForLeaks(text);
  assert.equal(findings.filter((f) => f.kind === 'redacted_thinking').length, 1);
});

test('detects encrypted_content envelopes', () => {
  const text = `{"reasoning":{"encrypted_content":"${'b'.repeat(50)}"}}`;
  assert.equal(scanForLeaks(text).filter((f) => f.kind === 'encrypted_content').length, 1);
});

test('flags plaintext secrets and a JWT', () => {
  const text = [
    'sk-ant-api03-abcdefghijklmnopqrstuv',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
  ].join('\n');
  const kinds = new Set(scanForLeaks(text).map((f) => f.kind));
  assert.ok(kinds.has('anthropic-key'));
  assert.ok(kinds.has('github-token'));
  assert.ok(kinds.has('jwt'));
});

test('dedupes emails and skips noreply/example', () => {
  const text = 'a@example.com b@example.com real.person@acme.io real.person@acme.io ci@noreply.github.com';
  const emails = scanForLeaks(text).filter((f) => f.kind === 'email');
  assert.equal(emails.length, 1);
  assert.equal(emails[0].preview.startsWith('real.per') || emails[0].preview.includes('@'), true);
});

test('stripEncryptedBlocks removes envelopes and leaves a marker', () => {
  const text = `{"signature":"${SIGNATURE}","t":"hi"}`;
  const { text: out, removed } = stripEncryptedBlocks(text);
  assert.equal(removed, 1);
  assert.ok(out.includes('[stripped:encrypted-reasoning]'));
  assert.ok(!out.includes(SIGNATURE));
  assert.equal(scanForLeaks(out).filter((f) => f.category === 'encrypted-block').length, 0);
});

test('redactSecrets replaces secrets but leaves emails unless includePii', () => {
  const text = 'key sk-ant-api03-abcdefghijklmnopqrst and mail me@acme.io';
  const kept = redactSecrets(text);
  assert.ok(kept.text.includes('[redacted:'));
  assert.ok(kept.text.includes('me@acme.io'), 'emails kept by default');
  const withPii = redactSecrets(text, { includePii: true });
  assert.ok(!withPii.text.includes('me@acme.io'));
});

test('sanitize strips and redacts in one pass', () => {
  const text = `{"signature":"${SIGNATURE}","t":"token sk-ant-api03-abcdefghijklmnopqrst"}`;
  const { removed, redacted } = sanitize(text);
  assert.equal(removed, 1);
  assert.ok(redacted >= 1);
});

test('clean text yields no findings', () => {
  const text = '{"m":"human","t":"what is the largest prime divisor of 8139881?"}';
  assert.equal(scanForLeaks(text).length, 0);
  assert.deepEqual(summarize([]), { 'encrypted-block': 0, secret: 0, pii: 0 });
});
