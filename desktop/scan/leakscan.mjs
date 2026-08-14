/**
 * Pre-publish leak scanner for session logs.
 *
 * Motivated by "Stealing Reasoning Traces from Proprietary LLM APIs"
 * (stolen-thoughts.com): providers return chain-of-thought as encrypted
 * blocks the client stores and replays. Those blocks are decryptable by a
 * sibling model, and the authors recovered 367 PII artifacts + 182
 * credentials from 315,320 blocks scraped from public repos. Plaintext
 * sanitization can't catch what's inside an opaque block — so before a
 * session log is published (or written to our own store) we (a) detect and
 * strip encrypted reasoning envelopes, and (b) flag residual plaintext
 * secrets/PII the model's own redaction may have missed.
 *
 * Dependency-free on purpose: runs in the Electron renderer (Vite import),
 * in the registry Lambda (pre-Dynamo pass), and under `node --test`.
 */

// ── encrypted reasoning envelopes ───────────────────────────────────
// Opaque provider-returned reasoning fields. Matched as JSON keys with a
// long base64/base64url value, plus Anthropic's redacted_thinking block.

const ENCRYPTED_FIELD_KEYS = [
  'signature',
  'encrypted_content',
  'redacted_thinking',
  'reasoning_encrypted',
  'encrypted_reasoning',
  'thinking_signature',
];

const ENCRYPTED_PATTERNS = ENCRYPTED_FIELD_KEYS.map((key) => ({
  key,
  // "key": "<>=40 chars of base64/base64url>"  (opaque envelope payload)
  re: new RegExp(`("${key}"\\s*:\\s*")([A-Za-z0-9+/_-]{40,}={0,2})(")`, 'g'),
}));

// Anthropic redacted-thinking block: {"type":"redacted_thinking","data":"…"}
const REDACTED_THINKING_RE =
  /\{\s*"type"\s*:\s*"redacted_thinking"\s*,\s*"data"\s*:\s*"[A-Za-z0-9+/_-]+={0,2}"\s*\}/g;

// ── plaintext secrets / PII ─────────────────────────────────────────

const SECRET_PATTERNS = [
  { category: 'secret', kind: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { category: 'secret', kind: 'openai-key', re: /sk-(?:proj-)?[A-Za-z0-9]{20,}/g },
  { category: 'secret', kind: 'github-token', re: /gh[posru]_[A-Za-z0-9]{30,}/g },
  { category: 'secret', kind: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/g },
  { category: 'secret', kind: 'google-key', re: /AIza[0-9A-Za-z_-]{35}/g },
  { category: 'secret', kind: 'slack-token', re: /xox[baprs]-[0-9A-Za-z-]{10,}/g },
  { category: 'secret', kind: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { category: 'secret', kind: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    category: 'secret',
    kind: 'password-assignment',
    re: /(?:password|passwd|pwd|secret)["']?\s*[:=]\s*["'][^"'\s]{6,}["']/gi,
  },
  { category: 'pii', kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
];

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function preview(s) {
  if (s.length <= 24) return s;
  return `${s.slice(0, 8)}…${s.slice(-4)} (${s.length} chars)`;
}

/**
 * Scan text for encrypted reasoning envelopes and residual secrets/PII.
 * Returns findings with a redacted preview (never the full secret) + line.
 */
export function scanForLeaks(text) {
  const findings = [];

  for (const { key, re } of ENCRYPTED_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      findings.push({
        category: 'encrypted-block',
        kind: key,
        line: lineOf(text, m.index),
        preview: preview(m[2]),
        reason: `opaque reasoning envelope in "${key}" — undecodable here, may hide PII/credentials`,
      });
    }
  }

  REDACTED_THINKING_RE.lastIndex = 0;
  let rt;
  while ((rt = REDACTED_THINKING_RE.exec(text))) {
    findings.push({
      category: 'encrypted-block',
      kind: 'redacted_thinking',
      line: lineOf(text, rt.index),
      preview: preview(rt[0]),
      reason: 'redacted-thinking block — provider-encrypted reasoning',
    });
  }

  const emailSeen = new Set();
  for (const { category, kind, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      // Emails are noisy; dedupe and skip obvious noreply/example addresses.
      if (kind === 'email') {
        const addr = m[0].toLowerCase();
        if (emailSeen.has(addr)) continue;
        emailSeen.add(addr);
        if (/@(?:example\.|.*noreply|.*no-reply)/.test(addr)) continue;
      }
      findings.push({
        category,
        kind,
        line: lineOf(text, m.index),
        preview: preview(m[0]),
        reason:
          category === 'pii'
            ? `plaintext ${kind} — confirm it belongs in a public log`
            : `plaintext ${kind} — a live secret in a shared log`,
      });
    }
  }

  return findings;
}

/**
 * Strip encrypted reasoning envelopes from text, replacing each with a
 * marker so the record stays valid-ish JSON and the removal is auditable.
 * Returns the cleaned text and how many envelopes were removed.
 */
export function stripEncryptedBlocks(text) {
  let removed = 0;
  let out = text;
  for (const { re } of ENCRYPTED_PATTERNS) {
    out = out.replace(re, (_full, pre, _payload, post) => {
      removed++;
      return `${pre}[stripped:encrypted-reasoning]${post}`;
    });
  }
  out = out.replace(REDACTED_THINKING_RE, () => {
    removed++;
    return '{"type":"redacted_thinking","data":"[stripped]"}';
  });
  return { text: out, removed };
}

/**
 * Redact plaintext secrets (not PII by default — emails are often
 * legitimately present) for a sanitized copy. Returns cleaned text + count.
 */
export function redactSecrets(text, { includePii = false } = {}) {
  let redacted = 0;
  let out = text;
  for (const { category, re } of SECRET_PATTERNS) {
    if (category === 'pii' && !includePii) continue;
    out = out.replace(re, (match) => {
      redacted++;
      return `[redacted:${match.length}]`;
    });
  }
  return { text: out, redacted };
}

/** Convenience: strip envelopes + redact secrets in one pass (pre-store use). */
export function sanitize(text, opts) {
  const a = stripEncryptedBlocks(text);
  const b = redactSecrets(a.text, opts);
  return { text: b.text, removed: a.removed, redacted: b.redacted };
}

export function summarize(findings) {
  const by = { 'encrypted-block': 0, secret: 0, pii: 0 };
  for (const f of findings) by[f.category] = (by[f.category] ?? 0) + 1;
  return by;
}
