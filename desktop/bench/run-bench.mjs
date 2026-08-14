#!/usr/bin/env node
/**
 * Self-contained turn-benchmark runner.
 *
 * Usage: node run-bench.mjs <owner/name> <benchmark-id> [branch]
 *
 * Fetches the repo's llm-turn-history.jsonl from raw.githubusercontent.com,
 * parses it with the same (ts, id) ordering + id-dedupe semantics as
 * app/src/lib/opensession.ts, evaluates every turn against the selected
 * benchmark, and prints a JSON report to stdout.
 *
 * Deliberately dependency-free: the exact same file runs unchanged inside a
 * disposable Daytona sandbox (clean-room verification) or locally (fallback).
 */

const HISTORY_FILE = 'llm-turn-history.jsonl';

// ── minimal open-session-jsonl parser (subset of app/src/lib/opensession.ts) ──

function parseArchive(text) {
  const errors = [];
  const sessions = [];
  const bySid = new Map();
  const messages = [];
  const seen = new Set();
  let current = null;

  text.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (e) {
      errors.push({ line: i + 1, error: String(e.message ?? e) });
      return;
    }
    if (typeof obj !== 'object' || obj === null) {
      errors.push({ line: i + 1, error: 'not a JSON object' });
      return;
    }
    if (typeof obj.session === 'string' && obj.speakers && typeof obj.speakers === 'object') {
      const existing = obj.sid ? bySid.get(obj.sid) : undefined;
      if (existing) {
        Object.assign(existing.speakers, obj.speakers);
        current = existing;
      } else {
        const s = {
          sid: obj.sid,
          date: obj.session,
          tool: obj.tool,
          name: obj.name,
          speakers: { ...obj.speakers },
          turns: [],
        };
        sessions.push(s);
        if (obj.sid) bySid.set(obj.sid, s);
        current = s;
      }
      return;
    }
    if (typeof obj.m === 'string' && typeof obj.t === 'string') {
      const id = typeof obj.id === 'string' ? obj.id : `line-${i + 1}`;
      if (seen.has(id)) return; // union-merge dedupe
      seen.add(id);
      messages.push({ ...obj, id, _session: (obj.s && bySid.get(obj.s)) || current, _line: i + 1 });
    }
    // headers / identity / format-update records are ignored by the benches
  });

  messages.sort((a, b) => {
    const ka = `${a.ts ?? ''}|${a.id}`;
    const kb = `${b.ts ?? ''}|${b.id}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  for (const m of messages) (m._session ?? orphanSession(sessions)).turns.push(m);
  return { sessions: sessions.filter((s) => s.turns.length || s.sid), messages, errors };
}

function orphanSession(sessions) {
  let s = sessions.find((x) => x._orphan);
  if (!s) {
    s = { _orphan: true, date: '', speakers: {}, turns: [], name: '(no session record)' };
    sessions.push(s);
  }
  return s;
}

function speakerKind(session, m) {
  return session?.speakers?.[m.m]?.kind ?? (m.m.toLowerCase().includes('model') ? 'model' : 'unknown');
}

// ── benchmarks ────────────────────────────────────────────────────────────────

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const BENCHMARKS = {
  'structure-integrity': {
    title: 'Structure integrity',
    describe: 'Records parse, carry ULID ids + timestamps, and bind to a declared session.',
    run(archive) {
      const findings = [];
      for (const e of archive.errors) {
        findings.push({ turnId: null, line: e.line, flag: 'parse-error', reason: e.error });
      }
      for (const m of archive.messages) {
        if (!ULID_RE.test(m.id)) {
          findings.push(finding(m, 'non-ulid-id', `id "${m.id}" is not a ULID`));
        }
        if (!m.ts) findings.push(finding(m, 'missing-ts', 'turn has no ISO-8601 timestamp'));
        if (!m._session || m._session._orphan) {
          findings.push(finding(m, 'orphan-turn', 'turn is not bound to any session record'));
        }
      }
      const denom = archive.messages.length + archive.errors.length || 1;
      return { findings, score: round(1 - findings.length / denom) };
    },
  },

  'turn-stats': {
    title: 'Turn stats & tool-activity coverage',
    describe: 'Volume per speaker kind, and how many model turns carry a recorded tool-activity summary.',
    run(archive) {
      let human = 0;
      let model = 0;
      let modelWithActivity = 0;
      const findings = [];
      for (const m of archive.messages) {
        const kind = speakerKind(m._session, m);
        if (kind === 'human') human++;
        if (kind === 'model') {
          model++;
          if (m.x) modelWithActivity++;
          else if (m.t.length > 400) {
            findings.push(finding(m, 'long-turn-no-activity', 'long model turn with no tool-activity summary'));
          }
        }
      }
      return {
        findings,
        score: model ? round(modelWithActivity / model) : 1,
        extra: { humanTurns: human, modelTurns: model, modelWithActivity },
      };
    },
  },

  'delusion-heuristic': {
    title: 'Delusion heuristic',
    describe:
      'Flags model turns making confident completion/verification claims with no recorded tool activity backing them — the cheap tripwire human "delusion" tags will gate in v1.',
    run(archive) {
      const confident =
        /\b(verified|confirmed|successfully|all tests pass(ed)?|works as expected|fixed and live|deployed|is now live|production is|guarantee[ds]?|definitely|fully (working|functional))\b/i;
      const findings = [];
      let model = 0;
      for (const m of archive.messages) {
        if (speakerKind(m._session, m) !== 'model') continue;
        model++;
        if (confident.test(m.t) && !m.x) {
          findings.push(
            finding(m, 'confident-claim-no-evidence', `confident claim with no tool-activity record: "${excerpt(m.t)}"`),
          );
        }
      }
      return { findings, score: model ? round(1 - findings.length / model) : 1 };
    },
  },
};

function finding(m, flag, reason) {
  return { turnId: m.id, line: m._line, speaker: m.m, ts: m.ts ?? null, flag, reason };
}

function excerpt(t) {
  const oneLine = t.replace(/\s+/g, ' ').trim();
  return oneLine.length > 140 ? `${oneLine.slice(0, 140)}…` : oneLine;
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

// ── main ─────────────────────────────────────────────────────────────────────

const [repo, benchId, branch = 'HEAD'] = process.argv.slice(2);
if (!repo || !benchId || !BENCHMARKS[benchId]) {
  process.stderr.write(
    `usage: run-bench.mjs <owner/name> <${Object.keys(BENCHMARKS).join('|')}> [branch]\n`,
  );
  process.exit(2);
}

const url = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/${HISTORY_FILE}`;
const res = await fetch(url);
if (!res.ok) {
  process.stderr.write(`fetch ${res.status} for ${url}\n`);
  process.exit(1);
}
const startedAt = new Date().toISOString();
const archive = parseArchive(await res.text());
const bench = BENCHMARKS[benchId];
const { findings, score, extra } = bench.run(archive);

const perSession = archive.sessions.map((s) => ({
  sid: s.sid ?? null,
  label: s.name ?? (s.tool ? `${s.date} · ${s.tool}` : s.date || '(unlabeled)'),
  turns: s.turns.length,
  flagged: findings.filter((f) => s.turns.some((t) => t.id === f.turnId)).length,
}));

process.stdout.write(
  `${JSON.stringify(
    {
      schema: 'opensession-bench-report/v0',
      repo,
      branch,
      benchmark: benchId,
      benchmarkTitle: bench.title,
      benchmarkDescription: bench.describe,
      startedAt,
      finishedAt: new Date().toISOString(),
      summary: {
        sessions: archive.sessions.length,
        turns: archive.messages.length,
        parseErrors: archive.errors.length,
        flagged: findings.length,
        score,
        ...(extra ?? {}),
      },
      perSession,
      findings,
    },
    null,
    2,
  )}\n`,
);
