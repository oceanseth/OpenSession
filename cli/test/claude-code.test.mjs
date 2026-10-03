import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, slugify } from '../lib/adapters/claude-code.mjs';

const REPO = 'C:\\work\\myrepo';
const line = (o) => JSON.stringify(o);

function userRec(uuid, text, ts, extra = {}) {
  return line({
    type: 'user',
    uuid,
    timestamp: ts,
    sessionId: 'sess-1',
    cwd: REPO,
    message: { role: 'user', content: [{ type: 'text', text }] },
    ...extra,
  });
}

function assistantRec(uuid, msgId, ts, { text, tool, usage, model = 'claude-fable-5', extra = {} } = {}) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  if (tool) content.push({ type: 'tool_use', name: tool, input: {} });
  return line({
    type: 'assistant',
    uuid,
    timestamp: ts,
    sessionId: 'sess-1',
    cwd: REPO,
    message: { role: 'assistant', id: msgId, model, content, usage },
    ...extra,
  });
}

const USAGE = { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 };

test('slugify matches Claude Code project-dir naming', () => {
  assert.equal(slugify('C:\\Users\\PC\\.buzz'), 'C--Users-PC--buzz');
});

test('reduces user + assistant runs into turns with summed usage', () => {
  const text = [
    userRec('u1', 'please fix the bug', '2026-10-03T10:00:00.000Z'),
    assistantRec('a1', 'msg_1', '2026-10-03T10:00:05.000Z', { text: 'Looking.', tool: 'Bash', usage: USAGE }),
    // second line of the same API message (per-block duplication): usage must not double-count
    assistantRec('a2', 'msg_1', '2026-10-03T10:00:05.500Z', { tool: 'Bash', usage: USAGE }),
    assistantRec('a3', 'msg_2', '2026-10-03T10:00:09.000Z', { text: 'Fixed it.', usage: USAGE }),
    userRec('u2', 'thanks', '2026-10-03T10:01:00.000Z'),
  ].join('\n');
  const parsed = parseTranscript(text, { repoDir: REPO });
  assert.equal(parsed.sessionKey, 'sess-1');
  assert.equal(parsed.turns.length, 3);
  const [human, model, thanks] = parsed.turns;
  assert.equal(human.role, 'human');
  assert.equal(human.text, 'please fix the bug');
  assert.equal(model.role, 'model');
  assert.equal(model.text, 'Looking.\n\nFixed it.');
  assert.equal(model.x, 'tools: Bash ×2');
  assert.deepEqual(
    { in: model.u.in, out: model.u.out, cr: model.u.cr, cw: model.u.cw },
    { in: 10, out: 40, cr: 100, cw: 200 },
  );
  assert.equal(model.u.model, 'claude-fable-5');
  assert.equal(model.u.ms, Date.parse('2026-10-03T10:00:09.000Z') - Date.parse('2026-10-03T10:00:00.000Z'));
  assert.ok(model.closed);
  assert.ok(thanks.closed);
});

test('trailing model turn is open (closed=false); partial tail line stops the watermark', () => {
  const full = [
    userRec('u1', 'go', '2026-10-03T10:00:00.000Z'),
    assistantRec('a1', 'msg_1', '2026-10-03T10:00:05.000Z', { text: 'working', usage: USAGE }),
  ].join('\n');
  const withPartial = `${full}\n{"type":"assistant","truncat`;
  const parsed = parseTranscript(withPartial, { repoDir: REPO });
  assert.equal(parsed.turns.length, 2);
  assert.equal(parsed.turns[1].closed, false);
  assert.equal(parsed.lastCompleteLine, 2);
});

test('skips sidechain text and meta records but bills sidechain usage to the open turn', () => {
  const text = [
    userRec('u1', 'go', '2026-10-03T10:00:00.000Z'),
    assistantRec('a1', 'msg_1', '2026-10-03T10:00:05.000Z', { text: 'delegating', usage: USAGE }),
    assistantRec('a2', 'msg_sub', '2026-10-03T10:00:06.000Z', {
      text: 'subagent chatter',
      usage: USAGE,
      extra: { isSidechain: true },
    }),
    userRec('u2', 'synthetic', '2026-10-03T10:00:07.000Z', { isMeta: true }),
    userRec('u3', 'done?', '2026-10-03T10:00:30.000Z'),
  ].join('\n');
  const parsed = parseTranscript(text, { repoDir: REPO });
  const model = parsed.turns[1];
  assert.equal(model.text, 'delegating');
  assert.equal(model.u.out, 40); // main + sidechain usage
  assert.equal(parsed.turns.length, 3); // meta user record did not become a turn
});

test('filters records whose cwd is outside the repo', () => {
  const text = [
    userRec('u1', 'outside', '2026-10-03T10:00:00.000Z', { cwd: 'C:\\somewhere\\else' }),
    userRec('u2', 'inside subdir', '2026-10-03T10:01:00.000Z', { cwd: `${REPO}\\src` }),
  ].join('\n');
  const parsed = parseTranscript(text, { repoDir: REPO });
  assert.deepEqual(
    parsed.turns.map((t) => t.text),
    ['inside subdir'],
  );
});

test('string-content user records and tool_result-only records', () => {
  const toolResult = line({
    type: 'user',
    uuid: 'u2',
    timestamp: '2026-10-03T10:00:06.000Z',
    cwd: REPO,
    message: { role: 'user', content: [{ type: 'tool_result', content: 'ran' }] },
  });
  const text = [
    line({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-10-03T10:00:00.000Z',
      sessionId: 'sess-1',
      cwd: REPO,
      message: { role: 'user', content: 'plain string' },
    }),
    assistantRec('a1', 'msg_1', '2026-10-03T10:00:05.000Z', { text: 'ok', tool: 'Bash', usage: USAGE }),
    toolResult,
    assistantRec('a2', 'msg_2', '2026-10-03T10:00:09.000Z', { text: 'done', usage: USAGE }),
    userRec('u3', 'next', '2026-10-03T10:01:00.000Z'),
  ].join('\n');
  const parsed = parseTranscript(text, { repoDir: REPO });
  // tool_result record must NOT split the model turn
  assert.equal(parsed.turns.length, 3);
  assert.equal(parsed.turns[0].text, 'plain string');
  assert.equal(parsed.turns[1].text, 'ok\n\ndone');
});
