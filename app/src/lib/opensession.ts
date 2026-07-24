/**
 * Parser for the open-session-jsonl format (v0.3, with legacy v0.2 tolerance)
 * as specified in OPEN-SESSION-LICENSE.md.
 *
 * Records are ordered by (ts, id) at read time — never by file position — and
 * deduped by id, so archives merged from parallel branches render correctly.
 */

export interface HeaderRecord {
  kind: 'header';
  format: string;
  version: string;
  preface?: string;
  docs?: string;
}

export interface Speaker {
  kind: 'human' | 'model';
  name?: string;
  id?: string;
  github?: string;
}

export interface SessionRecord {
  kind: 'session';
  session: string; // ISO date
  tool?: string;
  speakers: Record<string, Speaker>;
}

export interface MessageRecord {
  kind: 'message';
  id: string; // ULID (or synthetic for legacy records)
  m: string; // speaker abbreviation
  t: string; // verbatim turn text
  ts?: string; // ISO-8601 UTC
  x?: string; // tool-activity summary (model turns)
  n?: number; // legacy v0.2 monotonic counter
}

export interface IdentityRecord {
  kind: 'identity';
  identity: string; // speaker abbreviation
  method: string; // 'ssh-signature' | 'gh-session' | 'voicecert' | ...
  github?: string;
  github_id?: number;
  ts?: string;
  [key: string]: unknown;
}

export interface FormatUpdateRecord {
  kind: 'format-update';
  format: string;
  version: string;
  note?: string;
}

export interface UnknownRecord {
  kind: 'unknown';
  raw: unknown;
}

export type OpenSessionRecord =
  | HeaderRecord
  | SessionRecord
  | MessageRecord
  | IdentityRecord
  | FormatUpdateRecord
  | UnknownRecord;

export interface ParsedArchive {
  header?: HeaderRecord;
  sessions: ParsedSession[];
  /** All records in (ts, id) order, deduped by id. */
  records: OpenSessionRecord[];
  /** Lines that failed to parse as JSON, with their line numbers. */
  errors: { line: number; text: string; error: string }[];
}

export interface ParsedSession {
  session: SessionRecord;
  messages: MessageRecord[];
  identities: IdentityRecord[];
}

function classify(obj: Record<string, unknown>): OpenSessionRecord {
  if (typeof obj.format === 'string' && typeof obj.version === 'string') {
    const base = { format: obj.format, version: obj.version };
    if ('preface' in obj || 'docs' in obj) {
      return {
        kind: 'header',
        ...base,
        preface: obj.preface as string | undefined,
        docs: obj.docs as string | undefined,
      };
    }
    return { kind: 'format-update', ...base, note: obj.note as string | undefined };
  }
  if (typeof obj.session === 'string' && typeof obj.speakers === 'object' && obj.speakers) {
    return {
      kind: 'session',
      session: obj.session,
      tool: obj.tool as string | undefined,
      speakers: obj.speakers as Record<string, Speaker>,
    };
  }
  if (typeof obj.identity === 'string') {
    return { kind: 'identity', ...(obj as object), identity: obj.identity, method: String(obj.method ?? 'unknown') };
  }
  if (typeof obj.m === 'string' && typeof obj.t === 'string') {
    return {
      kind: 'message',
      id: typeof obj.id === 'string' ? obj.id : syntheticId(obj),
      m: obj.m,
      t: obj.t,
      ts: obj.ts as string | undefined,
      x: obj.x as string | undefined,
      n: typeof obj.n === 'number' ? obj.n : undefined,
    };
  }
  return { kind: 'unknown', raw: obj };
}

/** Legacy v0.2 records have no id; synthesize a stable one from (n, m, t). */
function syntheticId(obj: Record<string, unknown>): string {
  const basis = `${obj.n ?? ''}|${obj.m}|${obj.t}`;
  let h = 0;
  for (let i = 0; i < basis.length; i++) h = (Math.imul(h, 31) + basis.charCodeAt(i)) | 0;
  return `legacy-${String(obj.n ?? 0).padStart(8, '0')}-${(h >>> 0).toString(36)}`;
}

/** Sort key per spec: (ts, id), with ts-less legacy records ordered by n then position. */
function sortKey(r: OpenSessionRecord, position: number): [string, string, number] {
  if (r.kind === 'message') {
    const ts = r.ts ?? '';
    const legacyN = r.n !== undefined ? r.n : position;
    return [ts, r.id, legacyN];
  }
  if (r.kind === 'identity' || r.kind === 'session') {
    const ts = (r as { ts?: string }).ts ?? '';
    return [ts, '', position];
  }
  return ['', '', position];
}

export function parseOpenSessionJsonl(text: string): ParsedArchive {
  const errors: ParsedArchive['errors'] = [];
  const raw: { record: OpenSessionRecord; position: number }[] = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
        throw new Error('record is not a JSON object');
      }
      raw.push({ record: classify(obj as Record<string, unknown>), position: i });
    } catch (e) {
      errors.push({ line: i + 1, text: trimmed.slice(0, 200), error: e instanceof Error ? e.message : String(e) });
    }
  });

  let header: HeaderRecord | undefined;
  const seen = new Set<string>();
  const kept: { record: OpenSessionRecord; position: number }[] = [];
  for (const entry of raw) {
    const r = entry.record;
    if (r.kind === 'header' && !header) {
      header = r;
      continue;
    }
    if (r.kind === 'message') {
      if (seen.has(r.id)) continue; // dedupe by id (union merges)
      seen.add(r.id);
    }
    kept.push(entry);
  }

  // Header stays first; sessions/messages/identities ordered by (ts, id).
  // Session records lack ts, so they act as boundaries: messages are assigned
  // to the most recent session record *in file order*, then sorted within it.
  const sessions: ParsedSession[] = [];
  let current: ParsedSession | undefined;
  const orphanMessages: MessageRecord[] = [];
  const orphanIdentities: IdentityRecord[] = [];
  for (const { record } of kept) {
    if (record.kind === 'session') {
      current = { session: record, messages: [], identities: [] };
      sessions.push(current);
    } else if (record.kind === 'message') {
      (current ? current.messages : orphanMessages).push(record);
    } else if (record.kind === 'identity') {
      (current ? current.identities : orphanIdentities).push(record);
    }
  }
  if ((orphanMessages.length || orphanIdentities.length) && sessions.length === 0) {
    // Archive with no session record at all — synthesize one so messages render.
    sessions.push({
      session: { kind: 'session', session: '', speakers: {} },
      messages: orphanMessages,
      identities: orphanIdentities,
    });
  } else if (orphanMessages.length || orphanIdentities.length) {
    sessions[0].messages.unshift(...orphanMessages);
    sessions[0].identities.unshift(...orphanIdentities);
  }

  for (const s of sessions) {
    s.messages.sort((a, b) => compareKeys(sortKey(a, 0), sortKey(b, 0)));
  }

  const ordered = kept
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => compareKeys(sortKey(a.record, a.position), sortKey(b.record, b.position)))
    .map((e) => e.record);

  return { header, sessions, records: header ? [header, ...ordered] : ordered, errors };
}

function compareKeys(a: [string, string, number], b: [string, string, number]): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return a[2] - b[2];
}

/** Resolve a message's speaker from its session's speaker table. */
export function speakerOf(session: ParsedSession, msg: MessageRecord): Speaker | undefined {
  return session.session.speakers[msg.m];
}
