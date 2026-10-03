import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { HISTORY_FILE, appendRecords, importPass, renderTranscript, sidFor, ensureGitattributes } from '../lib/capture.mjs';
import * as claudeCode from '../lib/adapters/claude-code.mjs';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'oscap-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  return dir;
}

const USAGE = { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 20 };

function transcript(turnPairs, { openTail = false, cwd = 'C:\\work\\myrepo' } = {}) {
  const REPO_CWD = cwd;
  const lines = [];
  let n = 0;
  for (const [ask, answer] of turnPairs) {
    n++;
    lines.push(
      JSON.stringify({
        type: 'user',
        uuid: `u${n}`,
        timestamp: `2026-10-03T10:0${n}:00.000Z`,
        sessionId: 'sess-1',
        cwd: REPO_CWD,
        message: { role: 'user', content: [{ type: 'text', text: ask }] },
      }),
    );
    if (answer) {
      lines.push(
        JSON.stringify({
          type: 'assistant',
          uuid: `a${n}`,
          timestamp: `2026-10-03T10:0${n}:30.000Z`,
          sessionId: 'sess-1',
          cwd: REPO_CWD,
          message: { role: 'assistant', id: `msg_${n}`, model: 'claude-fable-5', content: [{ type: 'text', text: answer }], usage: USAGE },
        }),
      );
    }
  }
  if (!openTail) {
    n++;
    lines.push(
      JSON.stringify({
        type: 'user',
        uuid: `u${n}`,
        timestamp: `2026-10-03T10:0${n}:00.000Z`,
        sessionId: 'sess-1',
        cwd: REPO_CWD,
        message: { role: 'user', content: [{ type: 'text', text: 'closing remark' }] },
      }),
    );
  }
  return lines.join('\n');
}

function historyLines(repo) {
  return readFileSync(join(repo, HISTORY_FILE), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('appendRecords creates the file with a header and never requires reading it', () => {
  const repo = makeRepo();
  appendRecords(repo, ['{"a":1}']);
  appendRecords(repo, ['{"b":2}']);
  const recs = historyLines(repo);
  assert.equal(recs[0].format, 'open-session-jsonl');
  assert.equal(recs[0].version, '0.5');
  assert.ok(recs[0].preface.includes('do not read'));
  assert.deepEqual(recs.slice(1), [{ a: 1 }, { b: 2 }]);
});

test('renderTranscript emits a session record + turns with deterministic ids and sid', () => {
  const parsed = claudeCode.parseTranscript(transcript([['hello', 'hi, done']]), { repoDir: 'C:\\work\\myrepo' });
  const r1 = renderTranscript(parsed, { harness: 'claude-code', human: 'Seth', quiesced: false });
  const r2 = renderTranscript(parsed, { harness: 'claude-code', human: 'Seth', quiesced: false });
  assert.deepEqual(r1.lines, r2.lines); // byte-identical re-render
  const session = JSON.parse(r1.lines[0]);
  assert.equal(session.sid, sidFor('claude-code', 'sess-1', parsed.sessionStartTs));
  assert.equal(session.speakers.h.name, 'Seth');
  assert.equal(session.speakers.m.id, 'claude-fable-5');
  const turns = r1.lines.slice(1).map((l) => JSON.parse(l));
  assert.equal(turns.length, 3);
  assert.ok(turns.every((t) => t.s === session.sid));
  assert.equal(turns[1].u.out, 20);
});

test('importPass: incremental watermark, open-tail hold-back, quiesce flush, idempotence', () => {
  const repo = makeRepo();
  const tfile = join(repo, 'fake-transcript.jsonl');
  const state = { files: {} };

  // Pass 1: an active transcript with an open trailing model turn.
  writeFileSync(tfile, transcript([['first ask', 'first answer']], { openTail: true, cwd: repo }));
  let results = importPass(repo, claudeCode, [tfile], state, { human: 'Seth', quiesceMs: 60_000, now: Date.now() });
  assert.equal(results[0].held, true);
  let recs = historyLines(repo).filter((r) => r.m);
  assert.equal(recs.length, 1); // only the closed human turn; model turn held back
  assert.equal(recs[0].t, 'first ask');

  // Pass 2: nothing changed, still not quiesced — no new records.
  results = importPass(repo, claudeCode, [tfile], state, { human: 'Seth', quiesceMs: 60_000, now: Date.now() });
  assert.equal(historyLines(repo).filter((r) => r.m).length, 1);

  // Pass 3: transcript has been quiet past the quiesce window — tail flushes.
  const old = (Date.now() - 120_000) / 1000;
  utimesSync(tfile, old, old);
  importPass(repo, claudeCode, [tfile], state, { human: 'Seth', quiesceMs: 60_000, now: Date.now() });
  recs = historyLines(repo).filter((r) => r.m);
  assert.deepEqual(
    recs.map((r) => r.t),
    ['first ask', 'first answer'],
  );

  // Pass 4: unchanged + flushed — fully idempotent, no-op.
  const before = readFileSync(join(repo, HISTORY_FILE), 'utf8');
  importPass(repo, claudeCode, [tfile], state, { human: 'Seth', quiesceMs: 60_000, now: Date.now() });
  assert.equal(readFileSync(join(repo, HISTORY_FILE), 'utf8'), before);

  // Lost state: deterministic ids mean a full re-import duplicates only ids readers dedupe.
  importPass(repo, claudeCode, [tfile], { files: {} }, { human: 'Seth', quiesceMs: 60_000, now: Date.now() });
  const all = historyLines(repo).filter((r) => r.m);
  const unique = new Set(all.map((r) => r.id));
  assert.equal(unique.size, 2); // same ids re-emitted — reader dedupe collapses them
});

test('ensureGitattributes adds the union-merge rule once', () => {
  const repo = makeRepo();
  assert.equal(ensureGitattributes(repo), true);
  assert.equal(ensureGitattributes(repo), false);
  const content = readFileSync(join(repo, '.gitattributes'), 'utf8');
  assert.ok(content.includes('llm-turn-history.jsonl merge=union'));
  assert.ok(existsSync(join(repo, '.gitattributes')));
});
