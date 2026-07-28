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
import { createHash, randomBytes } from 'node:crypto';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});
const { REPOS_TABLE, FOLLOWS_TABLE, AUTH_TABLE, IDENTITIES_TABLE, THREADS_TABLE, POSTS_TABLE, VOTES_TABLE, QUEUE_URL } =
  process.env;

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

    if (method === 'POST' && path === '/api/threads') return createThread(event, user);
    if (method === 'GET' && path === '/api/threads') return listThreads(event, user);
    const threadMatch = path.match(/^\/api\/threads\/([0-9A-HJKMNP-TV-Z]{26})$/);
    if (threadMatch && method === 'GET') return getThread(user, threadMatch[1]);
    const postMatch = path.match(/^\/api\/threads\/([0-9A-HJKMNP-TV-Z]{26})\/posts$/);
    if (postMatch && method === 'POST') return addPost(event, user, postMatch[1]);
    if (method === 'PUT' && path === '/api/vote') return putVote(event, user);
    if (method === 'GET' && path === '/api/identity') return getIdentity(user);
    if (method === 'PUT' && path === '/api/identity/x') return putXIdentity(event, user);
    if (method === 'DELETE' && path === '/api/identity/x') return deleteXIdentity(user);
    if (method === 'POST' && path === '/api/identity/resolve') return resolveIdentities(event);
    if (method === 'POST' && path === '/api/repos/match') return matchRepos(event, user);
    if (method === 'POST' && path === '/api/repos/submit') return submitRepo(event, user);
    if (method === 'GET' && path === '/api/follows') return listFollows(user);
    const followMatch = path.match(/^\/api\/follows\/(\d+)$/);
    if (followMatch && method === 'PUT') return putFollow(event, user, Number(followMatch[1]));
    if (followMatch && method === 'DELETE') return deleteFollow(user, Number(followMatch[1]));

    // 400, not 404: CloudFront rewrites 404s to the SPA's index.html.
    return json(400, { error: 'unknown_route' });
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
  if (res.status === 404) return json(422, { error: 'not_found', error_description: 'no such repository' });
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

// ── discussion threads (a Reddit layer over session turns) ──────────
//
// Every thread anchors to one turn of one repo's llm-turn-history.jsonl:
// (repo full name, turn record id). Threads carry a title + description,
// posts form a reply tree, and both take up/down votes. Creator/author X
// handles are denormalized at write time from the identities table.

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulid() {
  let ts = '';
  let n = Date.now();
  for (let i = 0; i < 10; i++) {
    ts = B32[n % 32] + ts;
    n = Math.floor(n / 32);
  }
  let rnd = '';
  const bytes = randomBytes(16);
  for (let i = 0; i < 16; i++) rnd += B32[bytes[i] % 32];
  return ts + rnd;
}

const publicThread = (t, myVote) => ({
  id: t.threadId,
  repo: t.repo,
  turn_id: t.turnId,
  turn_ts: t.turnTs ?? null,
  turn_speaker: t.turnSpeaker ?? null,
  turn_excerpt: t.turnExcerpt,
  title: t.title,
  description: t.description,
  creator: { github_id: t.creatorId, github_login: t.creatorLogin, x_handle: t.creatorXHandle ?? null },
  created_at: t.createdAt,
  score: t.score ?? 0,
  reply_count: t.replyCount ?? 0,
  my_vote: myVote ?? 0,
});

const publicPost = (p, myVote) => ({
  id: p.postId,
  parent_id: p.parentId ?? null,
  text: p.text,
  author: { github_id: p.authorId, github_login: p.authorLogin, x_handle: p.authorXHandle ?? null },
  created_at: p.createdAt,
  score: p.score ?? 0,
  my_vote: myVote ?? 0,
});

async function xHandleOf(userId) {
  const item = (await ddb.send(new GetCommand({ TableName: IDENTITIES_TABLE, Key: { userId } }))).Item;
  return item?.xHandle ?? null;
}

/** The caller's votes on a set of target ids, as {targetId: value}. */
async function myVotes(userId, targetIds) {
  const votes = {};
  for (const chunk of chunks(targetIds, 100)) {
    const res = await ddb.send(new BatchGetCommand({
      RequestItems: { [VOTES_TABLE]: { Keys: chunk.map((targetId) => ({ targetId, userId })) } },
    }));
    for (const v of res.Responses?.[VOTES_TABLE] ?? []) votes[v.targetId] = v.value;
  }
  return votes;
}

async function createThread(event, user) {
  const b = parseBody(event) ?? {};
  const repo = String(b.repo ?? '');
  const turnId = String(b.turn_id ?? '');
  const title = String(b.title ?? '').trim().slice(0, 140);
  const description = String(b.description ?? '').trim().slice(0, 5000);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json(400, { error: 'bad_request', error_description: 'repo must be owner/name' });
  if (!/^[\w:-]{1,64}$/.test(turnId)) return json(400, { error: 'bad_request', error_description: 'turn_id required' });
  if (!title) return json(400, { error: 'bad_request', error_description: 'title required' });

  const item = {
    threadId: ulid(),
    gsiPk: 'T',
    repo,
    turnId,
    turnTs: typeof b.turn_ts === 'string' ? b.turn_ts.slice(0, 40) : null,
    turnSpeaker: typeof b.turn_speaker === 'string' ? b.turn_speaker.slice(0, 80) : null,
    turnExcerpt: String(b.turn_excerpt ?? '').slice(0, 280),
    title,
    description,
    creatorId: user.userId,
    creatorLogin: user.login,
    creatorXHandle: await xHandleOf(user.userId),
    createdAt: Date.now(),
    score: 0,
    replyCount: 0,
  };
  await ddb.send(new PutCommand({ TableName: THREADS_TABLE, Item: item }));
  return json(200, { thread: publicThread(item, 0) });
}

async function listThreads(event, user) {
  const repo = event.queryStringParameters?.repo;
  const q = await ddb.send(new QueryCommand({
    TableName: THREADS_TABLE,
    IndexName: 'list',
    KeyConditionExpression: 'gsiPk = :t',
    ExpressionAttributeValues: { ':t': 'T' },
    ScanIndexForward: false, // ULID range key → newest first
    Limit: 200,
  }));
  let items = q.Items ?? [];
  if (repo) items = items.filter((t) => t.repo === repo);
  const votes = await myVotes(user.userId, items.map((t) => t.threadId));
  return json(200, { threads: items.map((t) => publicThread(t, votes[t.threadId])) });
}

async function getThread(user, threadId) {
  const thread = (await ddb.send(new GetCommand({ TableName: THREADS_TABLE, Key: { threadId } }))).Item;
  if (!thread) return json(400, { error: 'not_found', error_description: 'no such thread' });
  const q = await ddb.send(new QueryCommand({
    TableName: POSTS_TABLE,
    KeyConditionExpression: 'threadId = :t',
    ExpressionAttributeValues: { ':t': threadId },
    Limit: 500,
  }));
  const posts = q.Items ?? [];
  const votes = await myVotes(user.userId, [threadId, ...posts.map((p) => `${threadId}#${p.postId}`)]);
  return json(200, {
    thread: publicThread(thread, votes[threadId]),
    posts: posts.map((p) => publicPost(p, votes[`${threadId}#${p.postId}`])),
  });
}

async function addPost(event, user, threadId) {
  const b = parseBody(event) ?? {};
  const text = String(b.text ?? '').trim().slice(0, 5000);
  const parentId = typeof b.parent_id === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(b.parent_id) ? b.parent_id : null;
  if (!text) return json(400, { error: 'bad_request', error_description: 'text required' });
  const thread = (await ddb.send(new GetCommand({ TableName: THREADS_TABLE, Key: { threadId } }))).Item;
  if (!thread) return json(400, { error: 'not_found', error_description: 'no such thread' });

  const item = {
    threadId,
    postId: ulid(),
    parentId,
    text,
    authorId: user.userId,
    authorLogin: user.login,
    authorXHandle: await xHandleOf(user.userId),
    createdAt: Date.now(),
    score: 0,
  };
  await ddb.send(new PutCommand({ TableName: POSTS_TABLE, Item: item }));
  await ddb.send(new UpdateCommand({
    TableName: THREADS_TABLE,
    Key: { threadId },
    UpdateExpression: 'ADD replyCount :one',
    ExpressionAttributeValues: { ':one': 1 },
  }));
  return json(200, { post: publicPost(item, 0) });
}

/**
 * PUT /api/vote  body: {thread_id, post_id?, value: 1|0|-1}
 * Idempotent per (target, user): re-voting replaces; 0 clears. Score deltas
 * are applied to the thread/post record and the new score returned.
 */
async function putVote(event, user) {
  const b = parseBody(event) ?? {};
  const threadId = String(b.thread_id ?? '');
  const postId = typeof b.post_id === 'string' ? b.post_id : null;
  const value = b.value;
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(threadId) || ![1, 0, -1].includes(value) ||
      (postId && !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(postId))) {
    return json(400, { error: 'bad_request', error_description: 'thread_id and value 1|0|-1 required' });
  }
  const targetId = postId ? `${threadId}#${postId}` : threadId;
  const existing = (await ddb.send(new GetCommand({ TableName: VOTES_TABLE, Key: { targetId, userId: user.userId } }))).Item;
  const delta = value - (existing?.value ?? 0);
  if (delta === 0) return json(200, { my_vote: value, unchanged: true });

  if (value === 0) {
    await ddb.send(new DeleteCommand({ TableName: VOTES_TABLE, Key: { targetId, userId: user.userId } }));
  } else {
    await ddb.send(new PutCommand({ TableName: VOTES_TABLE, Item: { targetId, userId: user.userId, value, at: Date.now() } }));
  }
  const upd = await ddb.send(new UpdateCommand({
    TableName: postId ? POSTS_TABLE : THREADS_TABLE,
    Key: postId ? { threadId, postId } : { threadId },
    UpdateExpression: 'ADD score :d',
    ExpressionAttributeValues: { ':d': delta },
    ReturnValues: 'UPDATED_NEW',
  }));
  return json(200, { my_vote: value, score: upd.Attributes?.score ?? 0 });
}

// ── identities (GitHub ⇄ X linking) ─────────────────────────────────

const X_HANDLE_RE = /^@?([A-Za-z0-9_]{1,15})$/;
/**
 * Trust ladder for how an X handle was linked. 'claimed' is self-asserted in
 * the web app; 'extension' means the xChatHub extension witnessed the handle
 * logged in on x.com in the same browser. Higher methods must not be
 * overwritten by lower ones.
 */
const METHOD_RANK = { claimed: 1, extension: 2 };

const publicIdentity = (i) =>
  i ? { github_id: i.userId, github_login: i.githubLogin, x_handle: i.xHandle, method: i.method, linked_at: i.linkedAt } : null;

async function getIdentity(user) {
  const item = (await ddb.send(new GetCommand({ TableName: IDENTITIES_TABLE, Key: { userId: user.userId } }))).Item;
  return json(200, { identity: publicIdentity(item) });
}

async function putXIdentity(event, user) {
  const body = parseBody(event);
  const m = String(body?.handle ?? '').trim().match(X_HANDLE_RE);
  if (!m) return json(400, { error: 'bad_request', error_description: 'handle must be a valid X username' });
  const method = body?.method === 'extension' ? 'extension' : 'claimed';

  const existing = (await ddb.send(new GetCommand({ TableName: IDENTITIES_TABLE, Key: { userId: user.userId } }))).Item;
  if (existing && METHOD_RANK[existing.method] > METHOD_RANK[method] && existing.xHandle.toLowerCase() === m[1].toLowerCase()) {
    return json(200, { identity: publicIdentity(existing) }); // keep the stronger attestation
  }
  const item = { userId: user.userId, githubLogin: user.login, xHandle: m[1], method, linkedAt: Date.now() };
  await ddb.send(new PutCommand({ TableName: IDENTITIES_TABLE, Item: item }));
  return json(200, { identity: publicIdentity(item) });
}

async function deleteXIdentity(user) {
  await ddb.send(new DeleteCommand({ TableName: IDENTITIES_TABLE, Key: { userId: user.userId } }));
  return json(200, { identity: null });
}

/**
 * POST /api/identity/resolve  body: {github_ids: [numbers]}
 * Maps GitHub user ids → linked X identities. Only linked users appear;
 * linking is a public act in this system (that's its purpose).
 */
async function resolveIdentities(event) {
  const ids = parseBody(event)?.github_ids;
  if (!Array.isArray(ids) || ids.length > 500 || ids.some((i) => !Number.isInteger(i))) {
    return json(400, { error: 'bad_request', error_description: 'github_ids must be an array of at most 500 integers' });
  }
  const identities = {};
  for (const chunk of chunks([...new Set(ids)], 100)) {
    const res = await ddb.send(new BatchGetCommand({
      RequestItems: { [IDENTITIES_TABLE]: { Keys: chunk.map((userId) => ({ userId })) } },
    }));
    for (const item of res.Responses?.[IDENTITIES_TABLE] ?? []) identities[item.userId] = publicIdentity(item);
  }
  return json(200, { identities });
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
