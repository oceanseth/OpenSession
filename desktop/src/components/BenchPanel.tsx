import { useEffect, useState } from 'react';
import type { BenchReport } from '../types';

const DAYTONA_KEY = 'opensession.desktop.daytona-key';

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
export function BenchPanel({ repo }: { repo: string }) {
  const [benchmark, setBenchmark] = useState(BENCHMARKS[0].id);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(DAYTONA_KEY) ?? '');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string>();
  const [report, setReport] = useState<BenchReport | null>(null);
  const [error, setError] = useState<string>();
  const [savedTo, setSavedTo] = useState<string>();

  useEffect(() => window.desktop.onBenchProgress(setProgress), []);

  const run = async (useDaytona: boolean) => {
    setRunning(true);
    setError(undefined);
    setReport(null);
    setSavedTo(undefined);
    setProgress(useDaytona ? 'Contacting Daytona…' : 'Running locally…');
    if (useDaytona) localStorage.setItem(DAYTONA_KEY, apiKey.trim());
    try {
      const r = await window.desktop.runBench({
        repo,
        benchmark,
        daytonaApiKey: useDaytona ? apiKey.trim() : undefined,
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

      <input
        type="password"
        placeholder="Daytona API key (dtn_…)"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
      />
      <div className="row">
        <button disabled={running || !apiKey.trim()} onClick={() => void run(true)}>
          Run in Daytona
        </button>
        <button className="ghost" disabled={running} onClick={() => void run(false)}>
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
