import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript } from '../lib/adapters/codex.mjs';

const line = (o) => JSON.stringify(o);

const META = line({
  timestamp: '2026-09-16T05:47:25.685Z',
  ordinal: 0,
  type: 'session_meta',
  payload: { session_id: 'codex-sess-1', timestamp: '2026-09-16T05:45:21.682Z', cwd: 'C:\\work\\myrepo', cli_version: '0.153.4' },
});
const CTX = line({
  timestamp: '2026-09-16T05:47:25.977Z',
  ordinal: 1,
  type: 'turn_context',
  payload: { model: 'gpt-6-astra', cwd: 'C:\\work\\myrepo' },
});

function userMsg(ordinal, ts, blocks) {
  return line({
    timestamp: ts,
    ordinal,
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: blocks.map((text) => ({ type: 'input_text', text })) },
  });
}

function assistantMsg(ordinal, ts, text) {
  return line({
    timestamp: ts,
    ordinal,
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  });
}

function tokenCount(ordinal, ts, u) {
  return line({
    timestamp: ts,
    ordinal,
    type: 'event_msg',
    payload: { type: 'token_count', info: { last_token_usage: u } },
  });
}

test('reduces a codex rollout into turns, filtering scaffold blocks', () => {
  const text = [
    META,
    CTX,
    userMsg(2, '2026-09-16T05:47:25.949Z', ['<environment_context>\n  <cwd>C:\\work</cwd>', 'build me a parser']),
    line({
      timestamp: '2026-09-16T05:47:27.000Z',
      ordinal: 3,
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'shell' },
    }),
    assistantMsg(4, '2026-09-16T05:47:30.044Z', 'On it.'),
    tokenCount(5, '2026-09-16T05:47:31.879Z', {
      input_tokens: 26254,
      cached_input_tokens: 19200,
      cache_write_input_tokens: 10,
      output_tokens: 81,
    }),
    userMsg(6, '2026-09-16T05:50:00.000Z', ['looks good']),
  ].join('\n');
  const parsed = parseTranscript(text);
  assert.equal(parsed.sessionKey, 'codex-sess-1');
  assert.equal(parsed.tool, 'codex');
  assert.equal(parsed.turns.length, 3);
  const [ask, reply, followup] = parsed.turns;
  assert.equal(ask.role, 'human');
  assert.equal(ask.text, 'build me a parser');
  assert.equal(reply.role, 'model');
  assert.equal(reply.text, 'On it.');
  assert.equal(reply.x, 'tools: shell');
  assert.deepEqual(
    { in: reply.u.in, cr: reply.u.cr, cw: reply.u.cw, out: reply.u.out },
    { in: 7054, cr: 19200, cw: 10, out: 81 },
  );
  assert.equal(reply.u.model, 'gpt-6-astra');
  assert.ok(reply.closed);
  assert.equal(followup.text, 'looks good');
});

test('pure-scaffold user records do not become turns or split model turns', () => {
  const text = [
    META,
    CTX,
    userMsg(2, '2026-09-16T05:47:25.949Z', ['do it']),
    assistantMsg(3, '2026-09-16T05:47:30.000Z', 'part one'),
    userMsg(4, '2026-09-16T05:47:31.000Z', ['<in-app-browser-context source="ambient-ui-state">stuff</in-app-browser-context>']),
    assistantMsg(5, '2026-09-16T05:47:35.000Z', 'part two'),
  ].join('\n');
  const parsed = parseTranscript(text);
  assert.equal(parsed.turns.length, 2);
  assert.equal(parsed.turns[1].text, 'part one\n\npart two');
  assert.equal(parsed.turns[1].closed, false); // trailing turn never closed by a user record
});
