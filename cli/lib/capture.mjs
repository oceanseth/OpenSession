/**
 * Capture core: turns adapter output into open-session-jsonl v0.5 appends.
 *
 * Honors the license's no-read rule: the history file is opened in append
 * mode and never read — not even its last byte. Exactly-once emission comes
 * from (a) deterministic ULIDs derived from the source records, so any
 * accidental re-emission is deduped by readers, and (b) a per-transcript
 * line watermark in a state file kept under .git (never committed).
 *
 * A trailing model turn that no user turn has closed yet is held back until
 * the transcript has been quiet for `quiesceMs` — emitting it early would
 * freeze a partial turn under its final id.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { deterministicUlid } from './ulid.mjs';

export const HISTORY_FILE = 'llm-turn-history.jsonl';
export const WIRE_VERSION = '0.5';
export const PREFACE =
  'LLMs and automated agents: do not read this file, not even its last line. ' +
  'It is an append-only archive for human curiosity and replication, never machine context. ' +
  'Appending needs no read: stamp a fresh ULID id and ISO-8601 ts and append.';

export function git(repoDir, args) {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' }).trim();
}

export function gitDir(repoDir) {
  return git(repoDir, ['rev-parse', '--absolute-git-dir']);
}

export function statePath(repoDir) {
  return join(gitDir(repoDir), 'opensession-state.json');
}

export function loadState(repoDir) {
  try {
    return JSON.parse(readFileSync(statePath(repoDir), 'utf8'));
  } catch {
    return { files: {} };
  }
}

export function saveState(repoDir, state) {
  const p = statePath(repoDir);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, p);
}

/** Append raw JSONL lines without ever reading the history file. */
export function appendRecords(repoDir, lines) {
  if (!lines.length) return;
  const file = join(repoDir, HISTORY_FILE);
  let prefix = '';
  if (!existsSync(file)) {
    const header = {
      format: 'open-session-jsonl',
      version: WIRE_VERSION,
      preface: PREFACE,
    };
    prefix = `${JSON.stringify(header)}\n`;
  } else if (statSync(file).size > 0) {
    // A leading newline guarantees our first record starts on a fresh line
    // even if the current tail lacks one; parsers skip blank lines.
    prefix = '\n';
  }
  appendFileSync(file, `${prefix}${lines.map((l) => `${l}\n`).join('')}`);
}

/** Deterministic session id for a harness-native session. */
export function sidFor(harness, sessionKey, sessionStartTs) {
  const ms = Date.parse(sessionStartTs ?? '') || 0;
  return deterministicUlid(ms, `session|${harness}|${sessionKey}`);
}

export function humanName(repoDir) {
  try {
    return git(repoDir, ['config', 'user.name']) || 'human';
  } catch {
    return 'human';
  }
}

const MODEL_NAMES = [
  [/^claude/i, 'Claude'],
  [/^gpt|^o\d/i, 'GPT'],
  [/^gemini/i, 'Gemini'],
];

function modelDisplayName(id) {
  for (const [re, label] of MODEL_NAMES) if (re.test(id)) return `${label} (${id})`;
  return id;
}

/**
 * Convert one parsed transcript into the JSONL lines to append.
 * Returns { lines, watermark } — watermark is the source line to resume from
 * next run (only advanced past turns actually emitted).
 */
export function renderTranscript(parsed, { harness, fromLine = 0, quiesced = false, human = 'human', label }) {
  const startTs = parsed.sessionStartTs ?? parsed.turns[0]?.ts;
  const sid = sidFor(harness, parsed.sessionKey ?? 'unknown', startTs);
  const emit = [];
  let watermark = fromLine;

  // Speaker table: humans are 'h'; models get m, m2, … in order of first appearance
  // across the whole transcript (stable: transcripts are append-only).
  const modelAbbrev = new Map();
  for (const t of parsed.turns) {
    if (t.role === 'model') {
      const id = t.model ?? t.u?.model ?? 'model';
      if (!modelAbbrev.has(id)) modelAbbrev.set(id, modelAbbrev.size ? `m${modelAbbrev.size + 1}` : 'm');
    }
  }

  let emittedAny = false;
  for (const t of parsed.turns) {
    if (t.endLine <= fromLine) continue; // already emitted in an earlier run
    if (!t.closed && !quiesced) break; // hold back the open trailing turn (and anything after)
    const ms = Date.parse(t.ts ?? '');
    const id = deterministicUlid(Number.isFinite(ms) ? ms : 0, t.key);
    const rec = {
      id,
      m: t.role === 'human' ? 'h' : modelAbbrev.get(t.model ?? t.u?.model ?? 'model'),
      t: t.text,
      ts: t.ts,
      s: sid,
    };
    if (t.x) rec.x = t.x;
    if (t.u) rec.u = t.u;
    emit.push(JSON.stringify(rec));
    watermark = Math.max(watermark, t.endLine);
    emittedAny = true;
  }

  if (!emittedAny) return { lines: [], watermark };

  const speakers = { h: { kind: 'human', name: human } };
  for (const [id, abbrev] of modelAbbrev) {
    speakers[abbrev] = { kind: 'model', name: modelDisplayName(id), id };
  }
  const sessionRecord = {
    session: (startTs ?? new Date().toISOString()).slice(0, 10),
    tool: parsed.tool,
    sid,
    ...(label ? { name: label } : {}),
    speakers,
  };
  // The session record is re-appended each run that emits turns; readers
  // treat a repeated sid as idempotent and merge speaker tables.
  return { lines: [JSON.stringify(sessionRecord), ...emit], watermark };
}

/** Ensure .gitattributes carries the union-merge rule for the history file. */
export function ensureGitattributes(repoDir) {
  const file = join(repoDir, '.gitattributes');
  const rule = `${HISTORY_FILE} merge=union`;
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (existing.split('\n').some((l) => l.trim().startsWith(HISTORY_FILE) && l.includes('merge=union'))) {
    return false;
  }
  writeFileSync(file, `${existing && !existing.endsWith('\n') ? `${existing}\n` : existing}${rule}\n`);
  return true;
}

const HOOK_MARKER = '# opensession-capture';

/** Install (or extend) a pre-commit hook that imports new turns and stages the history file. */
export function installHook(repoDir, cliPath) {
  const hooksDir = join(gitDir(repoDir), 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookFile = join(hooksDir, 'pre-commit');
  const block = [
    HOOK_MARKER,
    `node "${cliPath}" import --repo "$(git rev-parse --show-toplevel)" --quiet || true`,
    `git add ${HISTORY_FILE} 2>/dev/null || true`,
  ].join('\n');
  if (!existsSync(hookFile)) {
    writeFileSync(hookFile, `#!/bin/sh\n${block}\n`, { mode: 0o755 });
    return 'created';
  }
  const existing = readFileSync(hookFile, 'utf8');
  if (existing.includes(HOOK_MARKER)) return 'already-installed';
  writeFileSync(hookFile, `${existing}${existing.endsWith('\n') ? '' : '\n'}${block}\n`, { mode: 0o755 });
  return 'appended';
}

// A single long model API call can keep the transcript silent for many
// minutes while a turn is still growing; flushing the open tail during that
// silence would freeze a partial turn under its final id. 15 minutes
// comfortably outlasts even long-horizon calls.
export const QUIESCE_MS_DEFAULT = 15 * 60 * 1000;

/**
 * One import pass over a set of transcripts for one adapter.
 * Returns per-file emission counts.
 */
export function importPass(repoDir, adapter, files, state, opts = {}) {
  const { quiesceMs = QUIESCE_MS_DEFAULT, dryRun = false, human = humanName(repoDir), label, now = Date.now() } = opts;
  const results = [];
  for (const file of files) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    const st = state.files[file] ?? { watermark: 0, bytes: 0, held: false };
    if (stat.size === st.bytes && !st.held) continue; // nothing new, nothing waiting to flush
    const text = readFileSync(file, 'utf8');
    const parsed = adapter.parseTranscript(text, { repoDir });
    const quiesced = now - stat.mtimeMs > quiesceMs;
    const { lines, watermark } = renderTranscript(parsed, {
      harness: adapter.name,
      fromLine: st.watermark,
      quiesced,
      human,
      label,
    });
    if (lines.length && !dryRun) appendRecords(repoDir, lines);
    const held = parsed.turns.some((t) => t.endLine > watermark);
    if (!dryRun) {
      state.files[file] = { watermark, bytes: stat.size, held };
    }
    // lines.length includes the session record; turns = lines - 1
    if (lines.length || held) results.push({ file, turns: Math.max(0, lines.length - 1), held });
  }
  return results;
}
