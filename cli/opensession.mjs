#!/usr/bin/env node
/**
 * opensession — mechanical capture for the Open Session License.
 *
 * Converts harness-native transcripts (Claude Code, Codex) into
 * open-session-jsonl v0.5 appended to the repo's llm-turn-history.jsonl,
 * with zero agent cooperation: token usage, duration, and serving model
 * come straight from the harness's own metering.
 *
 *   opensession init    [--repo DIR] [--hook]        header + union-merge + optional pre-commit hook
 *   opensession import  [--repo DIR] [--harness H]   one-shot import of all past + new sessions
 *   opensession watch   [--repo DIR] [--interval S]  keep importing as sessions progress
 *
 * Common flags: --harness claude-code|codex|all (default all), --dry-run,
 * --quiesce S (default 900: seconds a transcript must be quiet before its
 * trailing, still-open model turn is flushed), --human NAME, --label LABEL,
 * --quiet, --full (ignore saved watermarks; deterministic ids keep readers
 * dedupe-safe either way).
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import * as claudeCode from './lib/adapters/claude-code.mjs';
import * as codex from './lib/adapters/codex.mjs';
import {
  HISTORY_FILE,
  ensureGitattributes,
  gitDir,
  humanName,
  importPass,
  installHook,
  loadState,
  saveState,
} from './lib/capture.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ADAPTERS = { 'claude-code': claudeCode, codex };

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      args._.push(a);
      continue;
    }
    const key = a.slice(2);
    const flagOnly = ['dry-run', 'quiet', 'hook', 'full', 'help'].includes(key);
    if (flagOnly) args[key] = true;
    else args[key] = argv[++i];
  }
  return args;
}

function usage(code = 0) {
  process.stderr.write(
    'usage: opensession <init|import|watch> [--repo DIR] [--harness claude-code|codex|all]\n' +
      '                   [--hook] [--interval S] [--quiesce S] [--dry-run] [--full]\n' +
      '                   [--human NAME] [--label LABEL] [--quiet]\n',
  );
  process.exit(code);
}

function selectedAdapters(args) {
  const h = args.harness ?? 'all';
  if (h === 'all') return Object.values(ADAPTERS);
  if (!ADAPTERS[h]) {
    process.stderr.write(`unknown harness "${h}" (have: ${Object.keys(ADAPTERS).join(', ')}, all)\n`);
    process.exit(2);
  }
  return [ADAPTERS[h]];
}

function log(args, msg) {
  if (!args.quiet) process.stdout.write(`${msg}\n`);
}

function runImport(repoDir, args) {
  const state = args.full ? { files: {} } : loadState(repoDir);
  const opts = {
    quiesceMs: (Number(args.quiesce) || 900) * 1000,
    dryRun: Boolean(args['dry-run']),
    human: args.human ?? humanName(repoDir),
    label: args.label,
  };
  let total = 0;
  let heldFiles = 0;
  for (const adapter of selectedAdapters(args)) {
    const files = args.transcript ? [resolve(args.transcript)] : adapter.discover(repoDir);
    const results = importPass(repoDir, adapter, files, state, opts);
    for (const r of results) {
      total += r.turns;
      if (r.held) heldFiles++;
      if (r.turns || r.held) {
        log(args, `${adapter.name}: ${r.turns} turn(s) from ${r.file}${r.held ? ' (open turn held back)' : ''}`);
      }
    }
  }
  if (!opts.dryRun) saveState(repoDir, state);
  log(
    args,
    `${opts.dryRun ? '[dry-run] would append' : 'appended'} ${total} turn(s) to ${HISTORY_FILE}` +
      (heldFiles ? `; ${heldFiles} transcript(s) still active (re-run or watch to flush)` : ''),
  );
  return total;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (!cmd || args.help) usage(cmd ? 0 : 2);
const repoDir = resolve(args.repo ?? process.cwd());
try {
  gitDir(repoDir); // capture state lives under .git — require a repository
} catch {
  process.stderr.write(`${repoDir} is not a git repository\n`);
  process.exit(2);
}

switch (cmd) {
  case 'init': {
    if (!existsSync(join(repoDir, HISTORY_FILE))) {
      log(args, `${HISTORY_FILE} will be created (with header) on first import`);
    }
    if (ensureGitattributes(repoDir)) log(args, '.gitattributes: added union-merge rule');
    else log(args, '.gitattributes: union-merge rule already present');
    if (args.hook) {
      const cliPath = fileURLToPath(import.meta.url);
      log(args, `pre-commit hook: ${installHook(repoDir, cliPath)}`);
    }
    log(args, 'done — run "opensession import" to capture past sessions');
    break;
  }
  case 'import': {
    runImport(repoDir, args);
    break;
  }
  case 'watch': {
    const interval = (Number(args.interval) || 15) * 1000;
    log(args, `watching for new turns every ${interval / 1000}s (ctrl-c to stop)`);
    const tick = () => {
      try {
        const n = runImport(repoDir, { ...args, quiet: true });
        if (n) log(args, `[${new Date().toISOString()}] appended ${n} turn(s)`);
      } catch (e) {
        process.stderr.write(`watch pass failed: ${e?.message ?? e}\n`);
      }
    };
    tick();
    setInterval(tick, interval);
    break;
  }
  default:
    usage(2);
}
