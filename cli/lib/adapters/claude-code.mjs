/**
 * Claude Code adapter: reads the harness-native transcripts under
 * ~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl and reduces them to
 * open-session turns.
 *
 * Transcript shape (one JSON object per line):
 *  - {type:'user', message:{content: string | [{type:'text'|'tool_result',...}]},
 *     uuid, timestamp, sessionId, cwd, isSidechain?, isMeta?}
 *  - {type:'assistant', message:{model, id, content:[{type:'text'|'thinking'|'tool_use',...}],
 *     usage:{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}},
 *     uuid, timestamp, cwd, isSidechain?}
 *    Claude Code may write one line per content block of the same API message
 *    (same message.id, duplicated usage) — usage is deduped by message.id.
 *  - other types (attachment, ai-title, queue-operation, …) are ignored.
 *
 * A logical model turn = the run of assistant records between two user text
 * records. Sidechain (subagent) records contribute their token usage to the
 * enclosing turn but not their text.
 */
import { readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const name = 'claude-code';

/** Claude Code names project dirs by replacing every non-alphanumeric cwd char with '-'. */
export function slugify(dir) {
  return resolve(dir).replace(/[^a-zA-Z0-9]/g, '-');
}

export function discover(repoDir, projectsRoot = join(homedir(), '.claude', 'projects')) {
  if (!existsSync(projectsRoot)) return [];
  const slug = slugify(repoDir);
  const files = [];
  for (const dir of readdirSync(projectsRoot)) {
    if (dir !== slug && !dir.startsWith(`${slug}-`)) continue;
    const full = join(projectsRoot, dir);
    for (const f of readdirSync(full)) {
      if (f.endsWith('.jsonl')) files.push(join(full, f));
    }
  }
  return files.sort();
}

function textOfUser(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n\n');
}

function withinRepo(cwd, repoDir) {
  if (!cwd) return false;
  const norm = (p) => resolve(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  const a = norm(cwd);
  const b = norm(repoDir);
  return a === b || a.startsWith(`${b}/`);
}

export function parseTranscript(text, { repoDir } = {}) {
  const lines = text.split('\n');
  let sessionKey = null;
  let sessionStartTs = null;
  let lastCompleteLine = 0;
  let lastCwd = null;
  const turns = [];

  let open = null; // accumulating model turn
  let lastHumanTs = null;
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
        key: `turn|claude-code|${sessionKey}|${open.firstUuid}`,
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
      break; // partially-written tail — stop; the watermark stays before it
    }
    lastCompleteLine = i + 1;
    if (!rec || typeof rec !== 'object') continue;
    if (rec.cwd) lastCwd = rec.cwd;
    if (!sessionKey && rec.sessionId) sessionKey = rec.sessionId;
    if (!sessionStartTs && typeof rec.timestamp === 'string') sessionStartTs = rec.timestamp;
    const inRepo = repoDir ? withinRepo(rec.cwd ?? lastCwd, repoDir) : true;

    if (rec.type === 'assistant' && rec.message) {
      if (!inRepo && !rec.isSidechain) continue;
      if (!open) {
        if (rec.isSidechain) continue; // sidechain spend with no enclosing turn — nothing to bill it to
        open = {
          firstUuid: rec.uuid,
          firstTs: rec.timestamp,
          anchorTs: lastHumanTs,
          lastTs: rec.timestamp,
          text: '',
          tools: new Map(),
          usage: { in: 0, out: 0, cr: 0, cw: 0, calls: 0 },
          seenMsgIds: new Set(),
          model: null,
          endLine: i + 1,
          closed: false,
        };
      }
      open.lastTs = rec.timestamp ?? open.lastTs;
      open.endLine = i + 1;
      const msg = rec.message;
      if (msg.usage && msg.id && !open.seenMsgIds.has(msg.id)) {
        open.seenMsgIds.add(msg.id);
        open.usage.in += msg.usage.input_tokens ?? 0;
        open.usage.out += msg.usage.output_tokens ?? 0;
        open.usage.cr += msg.usage.cache_read_input_tokens ?? 0;
        open.usage.cw += msg.usage.cache_creation_input_tokens ?? 0;
        open.usage.calls += 1;
      }
      if (!rec.isSidechain) {
        if (msg.model && msg.model !== '<synthetic>') open.model = msg.model;
        for (const block of Array.isArray(msg.content) ? msg.content : []) {
          if (block.type === 'text' && typeof block.text === 'string') {
            open.text = open.text ? `${open.text}\n\n${block.text}` : block.text;
          } else if (block.type === 'tool_use' && block.name) {
            open.tools.set(block.name, (open.tools.get(block.name) ?? 0) + 1);
          }
        }
      }
      continue;
    }

    if (rec.type === 'user' && rec.message && !rec.isSidechain && !rec.isMeta) {
      const t = textOfUser(rec.message);
      if (!t) continue; // tool_result-only record: the turn continues
      if (open) {
        open.closed = true;
        close();
      }
      lastHumanTs = rec.timestamp ?? lastHumanTs;
      if (inRepo) {
        turns.push({
          key: `turn|claude-code|${sessionKey}|${rec.uuid}`,
          role: 'human',
          text: t,
          ts: rec.timestamp,
          endLine: i + 1,
          closed: true,
        });
      }
    }
  }
  close(); // trailing model turn stays closed:false — emitted only once quiesced

  return { sessionKey, sessionStartTs, tool: 'claude-code', turns, lastCompleteLine };
}

function toolSummary(tools) {
  if (!tools.size) return undefined;
  const parts = [...tools.entries()].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
  return `tools: ${parts.join(', ')}`;
}
