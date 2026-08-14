import { useEffect, useMemo, useState } from 'react';
import { GitHubClient, HISTORY_FILE } from '@oslib/github';
import { sanitize, scanForLeaks, summarize, type LeakFinding } from '../../scan/leakscan.mjs';

const LABELS: Record<string, string> = {
  'encrypted-block': 'Encrypted reasoning',
  secret: 'Secrets',
  pii: 'PII',
};

/**
 * Pre-publish leak scan for the selected repo's raw history file. Surfaces
 * encrypted reasoning envelopes + residual plaintext secrets/PII, and offers
 * a sanitized copy — the defensive answer to the stolen-thoughts attack.
 */
export function LeakScanPanel({ repo, token }: { repo: string; token: string }) {
  const [raw, setRaw] = useState<string>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState<string>();

  useEffect(() => {
    setRaw(undefined);
    setError(undefined);
    setCopied(undefined);
    new GitHubClient(token)
      .fetchHistoryFile(repo)
      .then(setRaw)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [repo, token]);

  const findings = useMemo<LeakFinding[]>(() => (raw ? scanForLeaks(raw) : []), [raw]);
  const counts = summarize(findings);
  const total = findings.length;

  const copySanitized = async () => {
    if (!raw) return;
    const { text, removed, redacted } = sanitize(raw);
    await navigator.clipboard.writeText(text);
    setCopied(`Copied — ${removed} envelope${removed === 1 ? '' : 's'} stripped, ${redacted} secret${redacted === 1 ? '' : 's'} redacted`);
  };

  return (
    <aside className="bench">
      <h3>🛡 Leak scan</h3>
      <p className="muted">
        Scans <code>{HISTORY_FILE}</code> for provider-encrypted reasoning blocks and residual
        secrets before you publish or reshare. Encrypted blocks can hide credentials that plaintext
        sanitizing can't see — <a
          href="https://stolen-thoughts.com/paper.pdf"
          onClick={(e) => {
            e.preventDefault();
            void window.desktop.openExternal('https://stolen-thoughts.com/paper.pdf');
          }}
        >
          the stolen-thoughts research
        </a>{' '}
        recovered 367 PII items and 182 credentials from public logs this way.
      </p>

      {error && <p className="status error">{error}</p>}
      {!raw && !error && <p className="status">Fetching {repo}…</p>}

      {raw && (
        <>
          <div className="scan-summary">
            {(['encrypted-block', 'secret', 'pii'] as const).map((c) => (
              <div key={c} className={`scan-stat${counts[c] ? ' hit' : ''}`}>
                <span className="scan-n">{counts[c]}</span>
                <span>{LABELS[c]}</span>
              </div>
            ))}
          </div>

          {total === 0 ? (
            <p className="status good-text">✓ Clean — no encrypted blocks or secrets detected.</p>
          ) : (
            <ul className="findings">
              {findings.slice(0, 60).map((f, i) => (
                <li key={i}>
                  <code>{f.kind}</code> <span className="muted">line {f.line}</span> — {f.reason}
                  <div className="leak-preview">{f.preview}</div>
                </li>
              ))}
              {findings.length > 60 && <li className="muted">…and {findings.length - 60} more</li>}
            </ul>
          )}

          <div className="row">
            <button className="primary" onClick={() => void copySanitized()}>
              Copy sanitized JSONL
            </button>
          </div>
          {copied && <p className="status good-text">{copied}</p>}
        </>
      )}
    </aside>
  );
}
