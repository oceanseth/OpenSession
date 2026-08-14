import { useEffect, useState } from 'react';
import { useSettings } from '../lib/settings';
import type { BenchReport } from '../types';

const BENCHMARKS = [
  {
    id: 'structure-integrity',
    title: 'Structure integrity',
    blurb: 'ids, timestamps, session binding',
  },
  {
    id: 'turn-stats',
    title: 'Turn stats',
    blurb: 'volume + tool-activity coverage',
  },
  {
    id: 'delusion-heuristic',
    title: 'Delusion heuristic',
    blurb: 'confident claims with no recorded evidence',
  },
];

/** Run turn benchmarks for a repo in a Daytona sandbox (or locally) and show the report. */
export function BenchPanel({ repo, onOpenSettings }: { repo: string; onOpenSettings: () => void }) {
  const [benchmark, setBenchmark] = useState(BENCHMARKS[0].id);
  const { daytonaApiKey, rocketrideApiKey, rocketrideUri } = useSettings();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string>();
  const [report, setReport] = useState<BenchReport | null>(null);
  const [error, setError] = useState<string>();
  const [savedTo, setSavedTo] = useState<string>();

  useEffect(() => window.desktop.onBenchProgress(setProgress), []);

  const run = async (runner: 'daytona' | 'local' | 'rocketride') => {
    setRunning(true);
    setError(undefined);
    setReport(null);
    setSavedTo(undefined);
    setProgress('Starting…');
    try {
      const r = await window.desktop.runBench({
        repo,
        benchmark,
        runner,
        daytonaApiKey: runner === 'daytona' ? daytonaApiKey : undefined,
        rocketrideApiKey: runner === 'rocketride' ? rocketrideApiKey : undefined,
        rocketrideUri: runner === 'rocketride' ? rocketrideUri : undefined,
      });
      setReport(r);
      setProgress(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProgress(undefined);
    } finally {
      setRunning(false);
    }
  };

  return (
    <aside className="bench">
      <h3>Turn benchmarks</h3>
      <p className="muted">
        Evaluate every turn in <strong>{repo}</strong> against a benchmark. Daytona runs happen in
        a disposable sandbox — the report records the sandbox id, so the verification is
        clean-room and citable.
      </p>

      <div className="bench-list">
        {BENCHMARKS.map((b) => (
          <label key={b.id} className={benchmark === b.id ? 'bench-option active' : 'bench-option'}>
            <input
              type="radio"
              name="benchmark"
              checked={benchmark === b.id}
              onChange={() => setBenchmark(b.id)}
            />
            <span>
              <strong>{b.title}</strong>
              <em>{b.blurb}</em>
            </span>
          </label>
        ))}
      </div>

      {!daytonaApiKey && !rocketrideApiKey && (
        <p className="hint">
          No Daytona or RocketRide key configured —{' '}
          <button className="linklike" onClick={onOpenSettings}>
            add one in Settings
          </button>{' '}
          to enable cloud runs.
        </p>
      )}
      <div className="row">
        <button className="primary" disabled={running || !daytonaApiKey} onClick={() => void run('daytona')}>
          Run in Daytona
        </button>
        <button
          className="primary"
          disabled={running || !rocketrideApiKey}
          title="Grounded heuristics via a RocketRide Cloud pipeline"
          onClick={() => void run('rocketride')}
        >
          Run on RocketRide
        </button>
        <button className="ghost" disabled={running} onClick={() => void run('local')}>
          Run locally
        </button>
      </div>

      {progress && <p className="status">{progress}</p>}
      {error && <p className="status error">{error}</p>}

      {report && (
        <div className="report">
          <div className="report-head">
            <span className={`score ${report.summary.score >= 0.9 ? 'good' : report.summary.score >= 0.6 ? 'mid' : 'bad'}`}>
              {(report.summary.score * 100).toFixed(1)}
            </span>
            <div>
              <strong>{report.benchmarkTitle}</strong>
              <div className="muted">
                {report.summary.turns} turns · {report.summary.sessions} sessions ·{' '}
                {report.summary.flagged} flagged
                {report.runner?.kind === 'daytona'
                  ? ` · sandbox ${report.runner.sandboxId}`
                  : report.runner?.kind === 'rocketride'
                    ? ' · RocketRide Cloud'
                    : ' · ran locally'}
              </div>
            </div>
          </div>

          {report.perSession.length > 1 && (
            <ul className="per-session">
              {report.perSession.map((s, i) => (
                <li key={s.sid ?? i}>
                  <span className="hash">#</span>
                  {s.label} — {s.turns} turns, {s.flagged} flagged
                </li>
              ))}
            </ul>
          )}

          {report.findings.length > 0 && (
            <ul className="findings">
              {report.findings.slice(0, 50).map((f, i) => (
                <li key={`${f.turnId}-${i}`}>
                  <code>{f.flag}</code> {f.reason}
                  {f.ts && <span className="ts"> · {f.ts}</span>}
                </li>
              ))}
              {report.findings.length > 50 && (
                <li className="muted">…and {report.findings.length - 50} more in the exported report</li>
              )}
            </ul>
          )}

          <div className="row">
            <button
              onClick={() =>
                void window.desktop.saveReport(report).then((p) => p && setSavedTo(p))
              }
            >
              Export report JSON
            </button>
          </div>
          {savedTo && (
            <p className="status">
              Saved to {savedTo} — commit it to the repo (or attach it to the session thread) for
              public visibility.
            </p>
          )}
        </div>
      )}
    </aside>
  );
}
