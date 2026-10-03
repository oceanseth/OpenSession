# opensession CLI — mechanical session capture

Captures human–AI sessions into `llm-turn-history.jsonl` ([open-session-jsonl
v0.5](../OPEN-SESSION-LICENSE.md)) **with zero agent cooperation**: instead of
trusting the model to obey `AGENTS.md`, it reads the serving harness's own
transcripts and reduces them to verbatim open-session turns — including the
per-turn `u` usage object (token counts, duration, serving model) that the
harness already metered.

Dependency-free Node ≥ 18. No install needed:

```bash
node cli/opensession.mjs init   --repo /path/to/repo --hook   # one-time setup
node cli/opensession.mjs import --repo /path/to/repo          # import past + new sessions
node cli/opensession.mjs watch  --repo /path/to/repo          # keep importing live
```

## Commands

| Command | What it does |
|---|---|
| `init` | Ensures the `.gitattributes` union-merge rule; `--hook` installs a pre-commit hook that runs `import` and stages the history file, so every commit carries the turns that produced it |
| `import` | One-shot: finds every harness transcript belonging to the repo, converts new turns, appends them. Also the "import past sessions" path — the first run backfills the full local history |
| `watch` | Polls transcripts (default every 15 s) and appends turns as sessions progress |

Flags: `--harness claude-code|codex|all` (default `all`) · `--dry-run` ·
`--full` (ignore watermarks and rescan) · `--quiesce S` (default 900) ·
`--human NAME` (speaker name, default git `user.name`) · `--label LABEL`
(session `name`) · `--transcript FILE` (import one specific transcript) ·
`--quiet`.

## Supported harnesses

| Harness | Source | Usage metering |
|---|---|---|
| Claude Code | `~/.claude/projects/<cwd-slug>/*.jsonl` | per-API-call `usage` summed per turn (deduped by message id; subagent sidechains billed to the enclosing turn) |
| Codex CLI / Desktop | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `token_count` events accumulated per turn |

A transcript belongs to the repo when its records' `cwd` is inside the repo's
working tree. Injected scaffold blocks (Codex `<environment_context>` etc.) are
filtered; everything the human typed and the model answered is kept verbatim.
A logical turn spans all API calls and tool rounds between two human messages.

## Design guarantees

- **Never reads the history file.** Appends are blind (append mode only), per
  the license's no-read rule. If the existing tail lacks a newline, a leading
  blank line is emitted rather than reading to check — parsers skip blanks.
- **Idempotent by construction.** Every emitted record id is a *deterministic
  ULID*: timestamp from the source record, entropy from
  SHA-256(harness | session | record). Re-importing after lost state, from a
  second machine, or across union-merged branches re-emits byte-identical ids,
  and readers dedupe by id. A per-transcript line watermark (in
  `.git/opensession-state.json`, never committed) makes normal runs exact-once.
- **No frozen partial turns.** A still-open trailing model turn is held back
  until a following human turn closes it or the transcript has been quiet for
  `--quiesce` seconds (default 15 min — longer than even a long-horizon model
  API call stays silent) — its id derives from its first record, so emitting
  early would freeze a partial turn forever.
- **Session identity survives.** Each harness session becomes one
  open-session session record (deterministic `sid`); every turn carries
  `"s": sid`, so parallel sessions stay separable after union merges.

## Capture CLI vs. agent-appended logs

Pick one writer per session. If agents in the repo already append their own
turns per `AGENTS.md` (e.g. a Buzz-style meta-harness logging on behalf of
several agents), don't also run capture over those same sessions: the two
writers stamp different ids for the same turns, which readers can't dedupe.
Capture only imports transcripts whose `cwd` is inside the repo, which keeps
most such setups naturally disjoint.

## Tests

```bash
cd cli && npm test   # node --test, no dependencies
```
