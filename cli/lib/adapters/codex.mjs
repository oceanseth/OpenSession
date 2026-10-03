/**
 * Codex CLI / Desktop adapter: reads rollout transcripts under
 * ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl and reduces them to
 * open-session turns.
 *
 * Rollout shape (one JSON object per line, each with ordinal + timestamp):
 *  - {type:'session_meta', payload:{session_id|id, cwd, cli_version, ...}}
 *  - {type:'turn_context', payload:{model, cwd, ...}} — model serving the next turn(s)
 *  - {type:'response_item', payload:{type:'message', role:'user'|'assistant'|'developer',
 *     content:[{type:'input_text'|'output_text', text}]}}
 *    User records mix the typed prompt with injected scaffold blocks
 *    (<environment_context>, <app-context>, …); blocks starting with an XML-ish
 *    tag are scaffold and skipped, the rest is the human's turn.
 *  - {type:'response_item', payload:{type:'custom_tool_call'|'function_call', name}}
 *  - {type:'event_msg', payload:{type:'token_count', info:{last_token_usage:{
 *     input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens}}}}
 *    One per API call; accumulated into the open model turn.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const name = 'codex';

function walkJsonl(dir) {
  let out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walkJsonl(p));
    else if (entry.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function withinRepo(cwd, repoDir) {
  if (!cwd) return false;
  const norm = (p) => resolve(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  const a = norm(cwd);
  const b = norm(repoDir);
  return a === b || a.startsWith(`${b}/`);
}

export function discover(repoDir, sessionsRoot = join(homedir(), '.codex', 'sessions')) {
  if (!existsSync(sessionsRoot)) return [];
  const files = [];
  for (const f of walkJsonl(sessionsRoot).sort()) {
    try {
      if (!statSync(f).size) continue;
      // Cheap membership check: session_meta is the first line and carries cwd.
      const head = readFileSync(f, 'utf8').split('\n', 1)[0];
      const meta = JSON.parse(head);
      const cwd = meta?.payload?.cwd;
      if (withinRepo(cwd, repoDir)) files.push(f);
    } catch {
      // unreadable head — skip the file
    }
  }
  return files;
}

const SCAFFOLD_RE = /^\s*</; // injected <environment_context>, <app-context>, … blocks

function typedUserText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'input_text' && typeof b.text === 'string' && !SCAFFOLD_RE.test(b.text))
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

export function parseTranscript(text, _opts = {}) {
  const lines = text.split('\n');
  let sessionKey = null;
  let sessionStartTs = null;
  let lastCompleteLine = 0;
  let model = null;
  let lastHumanTs = null;
  const turns = [];

  let open = null;
  const close = () => {
    if (!open) return;
    if (open.text || open.x || open.usage.calls) {
      const u = {};
      if (open.usage.in) u.in = open.usage.in;
      if (open.usage.out) u.out = open.usage.out;
      if (open.usage.cr) u.cr = open.usage.cr;
      if (open.usage.cw) u.cw = open.usage.cw;
      const startMs = Date.parse(open.anchorTs ?? open.firstTs);
      const endMs = Date.parse(open.lastTs);
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) u.ms = endMs - startMs;
      if (open.model) u.model = open.model;
      turns.push({
        key: `turn|codex|${sessionKey}|${open.firstOrdinal}`,
        role: 'model',
        text: open.text,
        ts: open.firstTs,
        x: toolSummary(open.tools),
        u: Object.keys(u).length ? u : undefined,
        model: open.model,
        endLine: open.endLine,
        closed: open.closed,
      });
    }
    open = null;
  };
  const ensureOpen = (rec, i) => {
    if (open) return open;
    open = {
      firstOrdinal: rec.ordinal ?? i,
      firstTs: rec.timestamp,
      anchorTs: lastHumanTs,
      lastTs: rec.timestamp,
      text: '',
      tools: new Map(),
      usage: { in: 0, out: 0, cr: 0, cw: 0, calls: 0 },
      model,
      endLine: i + 1,
      closed: false,
    };
    return open;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      if (i === lines.length - 1) lastCompleteLine = i + 1;
      continue;
    }
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      break; // partially-written tail
    }
    lastCompleteLine = i + 1;
    const p = rec?.payload;
    if (!p) continue;

    if (rec.type === 'session_meta') {
      sessionKey = p.session_id ?? p.id ?? sessionKey;
      sessionStartTs = p.timestamp ?? rec.timestamp ?? sessionStartTs;
      continue;
    }
    if (rec.type === 'turn_context') {
      if (typeof p.model === 'string') model = p.model;
      continue;
    }
    if (rec.type === 'event_msg' && p.type === 'token_count' && p.info?.last_token_usage) {
      const u = p.info.last_token_usage;
      const t = ensureOpen(rec, i);
      t.usage.in += Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0));
      t.usage.cr += u.cached_input_tokens ?? 0;
      t.usage.cw += u.cache_write_input_tokens ?? 0;
      t.usage.out += u.output_tokens ?? 0;
      t.usage.calls += 1;
      t.lastTs = rec.timestamp ?? t.lastTs;
      t.endLine = i + 1;
      continue;
    }
    if (rec.type !== 'response_item') continue;

    if (p.type === 'custom_tool_call' || p.type === 'function_call' || p.type === 'local_shell_call') {
      const t = ensureOpen(rec, i);
      const toolName = p.name ?? p.type;
      t.tools.set(toolName, (t.tools.get(toolName) ?? 0) + 1);
      t.lastTs = rec.timestamp ?? t.lastTs;
      t.endLine = i + 1;
      continue;
    }
    if (p.type !== 'message') continue;

    if (p.role === 'assistant') {
      const t = ensureOpen(rec, i);
      const out = (p.content ?? [])
        .filter((b) => b && b.type === 'output_text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n\n');
      if (out) t.text = t.text ? `${t.text}\n\n${out}` : out;
      if (model) t.model = model;
      t.lastTs = rec.timestamp ?? t.lastTs;
      t.endLine = i + 1;
    } else if (p.role === 'user') {
      const typed = typedUserText(p.content);
      if (!typed) continue; // pure scaffold record
      if (open) {
        open.closed = true;
        close();
      }
      lastHumanTs = rec.timestamp ?? lastHumanTs;
      turns.push({
        key: `turn|codex|${sessionKey}|${rec.ordinal ?? i}`,
        role: 'human',
        text: typed,
        ts: rec.timestamp,
        endLine: i + 1,
        closed: true,
      });
    }
    // developer-role records are harness scaffold — ignored
  }
  close();

  return { sessionKey, sessionStartTs, tool: 'codex', turns, lastCompleteLine };
}

function toolSummary(tools) {
  if (!tools.size) return undefined;
  const parts = [...tools.entries()].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
  return `tools: ${parts.join(', ')}`;
}
