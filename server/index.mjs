/**
 * OpenSession registry API + verification worker (one Lambda, two triggers).
 *
 * API (HTTP API, routes under /api): the cached registry of repos known to
 * implement the Open Session License, keyed by GitHub numeric repo id, plus
 * per-user follow lists. Verification is server-side and demand-driven: repos
 * enter the queue when users submit starred lists or a repo URL, and the
 * worker rechecks any given repo at most once per day.
 *
 * Auth: callers pass their GitHub token (OAuth or PAT) as a Bearer header;
 * we resolve it to a GitHub user id via api.github.com (cached ~1h).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { createHash } from 'node:crypto';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});
const { REPOS_TABLE, FOLLOWS_TABLE, AUTH_TABLE, QUEUE_URL } = process.env;

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_FILE = 'llm-turn-history.jsonl';
const MAX_MATCH_REPOS = 2000;

export const handler = async (event) => {
  if (event.Records?.[0]?.eventSource === 'aws:sqs') return workerHandler(event);
  return apiHandler(event);
};

// ── verification worker ─────────────────────────────────────────────

async function workerHandler(event) {
  for (const record of event.Records) {
    const { repoId, fullName, by } = JSON.parse(record.body);
    try {
      await verifyRepo(repoId, fullName, by);
    } catch (e) {
      console.error(`verify failed for ${fullName} (${repoId}):`, e);
    }
  }
  return {};
}

/** Server-side license check via raw.githubusercontent.com — no API quota. */
async function verifyRepo(repoId, fullName, by) {
  const existing = (await ddb.send(new GetCommand({ TableName: REPOS_TABLE, Key: { repoId } }))).Item;
  const now = Date.now();
  if (existing?.lastCheckedAt && now - existing.lastCheckedAt < DAY_MS) return existing; // daily cap

  const res = await fetch(`https://raw.githubusercontent.com/${fullName}/HEAD/${HISTORY_FILE}`, {
    method: 'HEAD',
    redirect: 'follow',
  });
  const active = res.status === 200;
  const historySha = active ? (res.headers.get('etag') ?? '').replace(/^W\//, '').replace(/"/g, '') : existing?.historySha;
  const changed = active && historySha && historySha !== existing?.historySha;

  const item = {
    repoId,
    fullName,
    status: active ? 'active' : 'no-license',
    historySha: historySha ?? null,
    historySize: active ? Number(res.headers.get('content-length') ?? 0) : (existing?.historySize ?? null),
    lastCheckedAt: now,
    lastChangedAt: changed || (!existing?.lastChangedAt && active) ? now : (existing?.lastChangedAt ?? null),
    firstDetectedAt: existing?.firstDetectedAt ?? now,
    detectedBy: existing?.detectedBy ?? by ?? null,
  };
  await ddb.send(new PutCommand({ TableName: REPOS_TABLE, Item: item }));
  return item;
}

// ── API ─────────────────────────────────────────────────────────────

async function apiHandler(event) {
  const method = event.requestContext?.http?.method;
  const path = event.rawPath ?? '';
  try {
    const user = await authenticate(event);
    if (!user) return json(401, { error: 'unauthorized', error_description: 'valid GitHub token required' });

    if (method === 'POST' && path === '/api/repos/match') return matchRepos(event, user);
    if (method === 'POST' && path === '/api/repos/submit') return submitRepo(event, user);
    if (method === 'GET' && path === '/api/follows') return listFollows(user);
    const followMatch = path.match(/^\/api\/follows\/(\d+)$/);
    if (followMatch && method === 'PUT') return putFollow(event, user, Number(followMatch[1]));
    if (followMatch && method === 'DELETE') return deleteFollow(user, Number(followMatch[1]));

    return json(404, { error: 'not_found' });
  } catch (e) {
    console.error(e);
    return json(500, { error: 'internal', error_description: String(e?.message ?? e) });
  }
}

/** Resolve Bearer token → GitHub {userId, login}, cached ~1h by token hash. */
async function authenticate(event) {
  const auth = event.headers?.authorization ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const tokenHash = createHash('sha256').update(token).digest('hex');

  const cached = (await ddb.send(new GetCommand({ TableName: AUTH_TABLE, Key: { tokenHash } }))).Item;
  if (cached && cached.expiresAt * 1000 > Date.now()) return { userId: cached.userId, login: cached.login, token };

  const res = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'opensession' },
  });
  if (!res.ok) return null;
  const gh = await res.json();
  await ddb.send(new PutCommand({
    TableName: AUTH_TABLE,
    Item: { tokenHash, userId: gh.id, login: gh.login, expiresAt: Math.floor(Date.now() / 1000) + 3600 },
  }));
  return { userId: gh.id, login: gh.login, token };
}

/**
 * POST /api/repos/match  body: {repos: [{id, full_name}]}
 * Returns registry entries with active status among the submitted ids, and
 * queues unknown/stale repos for verification (worker enforces the daily cap).
 */
async function matchRepos(event, user) {
  const body = parseBody(event);
  const repos = Array.isArray(body?.repos) ? body.repos.slice(0, MAX_MATCH_REPOS) : null;
  if (!repos || repos.some((r) => !Number.isInteger(r.id) || typeof r.full_name !== 'string')) {
    return json(400, { error: 'bad_request', error_description: 'repos must be [{id, full_name}]' });
  }

  const found = new Map();
  for (const chunk of chunks(repos.map((r) => r.id), 100) ) {
    const res = await ddb.send(new BatchGetCommand({
      RequestItems: { [REPOS_TABLE]: { Keys: chunk.map((repoId) => ({ repoId })) } },
    }));
    for (const item of res.Responses?.[REPOS_TABLE] ?? []) found.set(item.repoId, item);
  }

  const now = Date.now();
  const toQueue = repos.filter((r) => {
    const known = found.get(r.id);
    return !known || now - (known.lastCheckedAt ?? 0) >= DAY_MS;
  });
  await enqueue(toQueue.map((r) => ({ repoId: r.id, fullName: r.full_name, by: user.login })));

  return json(200, {
    known: [...found.values()].filter((i) => i.status === 'active').map(publicRepo),
    // Checked within the last day and found without the artifact — lets the
    // client distinguish "no artifact" from "still being verified".
    inactive: [...found.values()].filter((i) => i.status === 'no-license').map((i) => i.repoId),
    queued: toQueue.length,
  });
}

/**
 * POST /api/repos/submit  body: {repo: "owner/name" | github URL}
 * Resolves via the caller's token (canonical id + name), verifies inline
 * (daily cap applies), and auto-follows on success.
 */
async function submitRepo(event, user) {
  const input = String(parseBody(event)?.repo ?? '').trim();
  const m = input.match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/);
  if (!m) return json(400, { error: 'bad_request', error_description: 'repo must be owner/name or a github.com URL' });

  const res = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}`, {
    headers: { Authorization: `Bearer ${user.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'opensession' },
  });
  if (res.status === 404) return json(404, { error: 'not_found', error_description: 'no such repository' });
  if (!res.ok) return json(502, { error: 'github_error', error_description: `github returned ${res.status}` });
  const gh = await res.json();

  const item = await verifyRepo(gh.id, gh.full_name, user.login);
  if (item.status !== 'active') {
    return json(422, {
      error: 'no_license',
      error_description: `${gh.full_name} has no ${HISTORY_FILE} on its default branch (last checked ${new Date(item.lastCheckedAt).toISOString()})`,
    });
  }
  await ddb.send(new PutCommand({
    TableName: FOLLOWS_TABLE,
    Item: { userId: user.userId, repoId: gh.id, fullName: gh.full_name, followedAt: Date.now() },
  }));
  return json(200, { repo: publicRepo(item), followed: true });
}

async function listFollows(user) {
  const q = await ddb.send(new QueryCommand({
    TableName: FOLLOWS_TABLE,
    KeyConditionExpression: 'userId = :u',
    ExpressionAttributeValues: { ':u': user.userId },
  }));
  const follows = q.Items ?? [];
  const records = new Map();
  for (const chunk of chunks(follows.map((f) => f.repoId), 100)) {
    const res = await ddb.send(new BatchGetCommand({
      RequestItems: { [REPOS_TABLE]: { Keys: chunk.map((repoId) => ({ repoId })) } },
    }));
    for (const item of res.Responses?.[REPOS_TABLE] ?? []) records.set(item.repoId, item);
  }
  return json(200, {
    follows: follows
      .sort((a, b) => (b.followedAt ?? 0) - (a.followedAt ?? 0))
      .map((f) => ({ ...publicRepo(records.get(f.repoId) ?? { repoId: f.repoId, fullName: f.fullName }), followedAt: f.followedAt })),
  });
}

async function putFollow(event, user, repoId) {
  const fullName = String(parseBody(event)?.full_name ?? '');
  await ddb.send(new PutCommand({
    TableName: FOLLOWS_TABLE,
    Item: { userId: user.userId, repoId, fullName, followedAt: Date.now() },
  }));
  // Make sure the followed repo is (or gets) verified.
  await enqueue([{ repoId, fullName, by: user.login }]);
  return json(200, { followed: true });
}

async function deleteFollow(user, repoId) {
  await ddb.send(new DeleteCommand({ TableName: FOLLOWS_TABLE, Key: { userId: user.userId, repoId } }));
  return json(200, { followed: false });
}

// ── helpers ─────────────────────────────────────────────────────────

const publicRepo = (i) => ({
  id: i.repoId,
  full_name: i.fullName,
  status: i.status ?? 'pending',
  history_sha: i.historySha ?? null,
  history_size: i.historySize ?? null,
  last_checked_at: i.lastCheckedAt ?? null,
  last_changed_at: i.lastChangedAt ?? null,
});

async function enqueue(messages) {
  const sends = [];
  for (const chunk of chunks(messages, 10)) {
    sends.push(sqs.send(new SendMessageBatchCommand({
      QueueUrl: QUEUE_URL,
      Entries: chunk.map((m, i) => ({ Id: String(i), MessageBody: JSON.stringify(m) })),
    })));
    if (sends.length >= 40) { await Promise.all(sends); sends.length = 0; } // bound in-flight batches
  }
  await Promise.all(sends);
}

function* chunks(arr, n) {
  for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n);
}

const parseBody = (event) => {
  try {
    return JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : (event.body ?? '{}'));
  } catch {
    return null;
  }
};

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
